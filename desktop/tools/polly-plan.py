#!/usr/bin/env python3
"""Validate the semantic ledger and generate its Markdown and session-SQL views."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
import sys

STATUSES = {"pending", "in_progress", "done", "blocked"}
KINDS = {"milestone", "task", "subtask", "catalog", "gate"}
MODES = {"common", "live", "fresh", "installed", "migration", "recovery", "hardware", "release", "candidate"}


def validate(plan):
    if type(plan.get("schemaVersion")) is not int or plan["schemaVersion"] != 1:
        raise ValueError("Unsupported plan format")
    nodes = plan["nodes"]
    by_id = {node["id"]: node for node in nodes}
    if len(by_id) != len(nodes):
        raise ValueError("Duplicate task ID")
    coverage = set()
    for node in nodes:
        if any(not isinstance(node.get(field), str) for field in
               ("id", "label", "kind", "status", "priority", "scope")) or \
                not isinstance(node.get("modes"), list) or not isinstance(node.get("requires"), list) or \
                not isinstance(node.get("sources"), list):
            raise ValueError("Invalid typed task fields")
        if node["kind"] not in KINDS or node["status"] not in STATUSES or \
                node["priority"] not in {"P0", "P1", "P2", "P3", "history"} or \
                not set(node["modes"]).issubset(MODES) or not node["modes"] or \
                not re.fullmatch(r"[a-z][a-z0-9-]*", node["id"]) or not node["scope"]:
            raise ValueError("Invalid semantic task: " + node["id"])
        if len(node["label"]) > 24:
            raise ValueError("Task label is too long: " + node["id"])
        parent = node.get("parent")
        if parent:
            if parent not in by_id or by_id[parent]["kind"] not in {"milestone", "task", "catalog"}:
                raise ValueError("Invalid ownership: " + node["id"])
            if node["kind"] == "task" and by_id[parent]["kind"] != "milestone":
                raise ValueError("Implementation task must belong to a delivery")
        elif node["kind"] not in {"milestone", "catalog", "gate"}:
            raise ValueError("Orphan execution item: " + node["id"])
        if node["kind"] == "subtask" and node["status"] == "done" and not node.get("evidence"):
            raise ValueError("Completed task needs scoped evidence: " + node["id"])
        for source in node.get("sources", []):
            if source not in plan["legacy"]:
                raise ValueError("Unknown historical requirement: " + source)
            coverage.add(source)
        if len(node.get("requires", [])) != len(set(node.get("requires", []))):
            raise ValueError("Duplicate prerequisite: " + node["id"])
        for required in node.get("requires", []):
            if required not in by_id or required == node["id"] or required == parent:
                raise ValueError("Invalid implementation prerequisite: " + node["id"])
            if by_id[required]["kind"] not in {"subtask", "gate"}:
                raise ValueError("Use a concrete prerequisite, not a whole category: " + node["id"])
            if "fresh" in node["modes"] and by_id[required]["modes"] == ["migration"]:
                raise ValueError("Fresh installation cannot wait for old-data migration")
            if node["priority"] in {"P0", "P1"} and by_id[required]["priority"] == "P3":
                raise ValueError("Core delivery cannot wait for an unselected direction")
    if coverage != set(plan["legacy"]):
        raise ValueError("Historical requirements were lost: " + ", ".join(sorted(set(plan["legacy"]) - coverage)))

    graph = {key: list(node.get("requires", [])) for key, node in by_id.items()}
    for node in nodes:
        if node.get("parent"):
            graph[node["parent"]].append(node["id"])
    active, finished = set(), set()

    def visit(key):
        if key in active:
            raise ValueError("Dependency/ownership cycle: " + key)
        if key in finished:
            return
        active.add(key)
        for child in graph[key]:
            visit(child)
        active.remove(key)
        finished.add(key)

    for key in graph:
        visit(key)
    return by_id


def rollup(nodes):
    by_id = {node["id"]: dict(node) for node in nodes}

    def state(key):
        node = by_id[key]
        children = [child["id"] for child in nodes if child.get("parent") == key]
        if node["kind"] == "catalog":
            node["status"] = "blocked"
        elif children:
            statuses = [state(child) for child in children]
            node["status"] = ("done" if all(value == "done" for value in statuses) else
                              "in_progress" if any(value in {"done", "in_progress"} for value in statuses) else
                              "blocked" if all(value == "blocked" for value in statuses) else "pending")
        elif node["status"] == "pending" and any(
                by_id[required]["kind"] == "gate" and by_id[required]["status"] == "blocked"
                for required in node.get("requires", [])):
            node["status"] = "blocked"
        return node["status"]

    for key in by_id:
        state(key)
    return by_id


def markdown(plan):
    nodes = plan["nodes"]
    by_id = rollup(nodes)
    state_names = {"done": "已完成", "pending": "待实现", "in_progress": "进行中/部分完成", "blocked": "待授权/待决策"}
    text = [
        "## 16. 完整执行清单与依赖",
        "",
        "计划数据唯一源为 `docs/POLLYOS-PLAN.json`；本节与应用 Plan 均从它生成，不分别维护状态。",
        "R 是可验收交付目标，T 是实现任务，子项是独立状态的执行单元；E 是独立增强交付物，C 是未选方向登记，H 是历史证据。",
        "旧 M 编号仅作来源索引，不再决定归属、顺序或依赖。拆分后的完成只承认对应组件证据，不继承整组验收。",
        "",
        "### 当前执行顺序与首个可用版本边界",
        "",
        "| 队列 | 当前交付 | 放行与并行边界 |",
        "| --- | --- | --- |",
        "| P0 / 先做 | R1 Live 账户与安装凭据隔离 | 先隔离公共底座与 Live 预设，再配置公开密码；不能污染安装模板 |",
        "| P0 / 底座 | R2 新安装启动与初始化 | 存储、账户及控制台链路已有组件；补角色和新策略候选验收，不等待旧系统迁移或完整 GUI |",
        "| P0 / 数据与维护 | R3 维护/救援；R4 迁移/共享应用 | 各叶子前置满足后独立推进；共享新安装不等待旧数据迁移整组完成，救援不是 Live root 默认密码入口 |",
        "| P1 / 日常 | R5 受保护日常桌面 | GUI、锁屏、网络、本地音频、文件和电源按具体后端就绪推进；不等待蓝牙、Portal 或正式发行 |",
        "| P1 / 实际交付 | R6 外置可用开发候选 | 指定介质和授权仍是硬门槛；先通过写入安全/虚拟候选，再按明确范围逐项验收，不机械依赖旧 M01–M07 的所有功能 |",
        "| P2 / 独立增强 | E 系列 | 每项有自己的验收边界，不自动成为 R1–R6 前置；休眠/加密/CI/正式身份保留额外授权 |",
        "| P3 / 未选方向 | C1 | 只登记方向，选择目标/范围后另立执行任务；不把全部候选变成一个必须完成的里程碑 |",
        "",
        "**依赖语义：** `归属`是完成汇总；`前置`是实际实现/验收所需的具体子项。父节点关闭依赖子节点，不反向阻塞子项开工。",
        "同一技术后端可以支撑不同交付物；跨组前置不改变归属。里程碑的进行中可以表示部分子项完成，不代表全组已开工。",
        "保持普通用户桌面、标准 PAM/passwd/su、版本配套服务账户、源/备份保留和故障显式拒绝；不整体共享 /etc 或 /var/lib。",
        "主会话优先实现并本地提交固定快照；编译/回归/镜像验收由临时 worktree 分支子会话异步承担，不在主会话等待。",
        "实现已提交但验证未返回的子项保持进行中并注明待验证；只有固定快照的证据通过才关闭。验证修复留在子分支，由主会话审阅合并，不自动 push/PR。",
        "每批更新 JSON 的状态/证据，运行 `desktop/tools/polly-plan.py --write` 生成文档并同步 Plan；主会话继续具备前置的实现。仅一个重型构建/VM lane，快速验证可并行。",
        "",
    ]
    children = {}
    for node in nodes:
        children.setdefault(node.get("parent"), []).append(node)

    def render(node, depth):
        actual = by_id[node["id"]]
        if node["kind"] in {"milestone", "catalog"}:
            text.extend(["", "### " + node["label"] + " — " + state_names[actual["status"]], "",
                         "**交付/边界：** " + node["scope"], ""])
        elif node["kind"] == "task":
            text.extend(["", "#### " + node["label"], "", node["scope"], ""])
        else:
            marker = "x" if actual["status"] == "done" else " "
            modes = "/".join(node["modes"])
            line = f"- [{marker}] **{node['label']}** · {state_names[actual['status']]} · {node['priority']} · {modes}：{node['scope']}"
            if node.get("requires"):
                line += " 前置：" + "、".join(by_id[key]["label"].split(" ", 1)[0] for key in node["requires"]) + "。"
            if node.get("sources"):
                line += " 来源：" + "、".join(node["sources"]) + "。"
            if node.get("evidence"):
                line += " 证据：" + node["evidence"]
            text.append(line)
        for child in children.get(node["id"], []):
            render(child, depth + 1)

    for node in children.get(None, []):
        render(node, 0)
    text.extend(["", "### 历史证据与当前产物边界", ""])
    text.extend(plan["evidenceNotes"])
    return "\n".join(text) + "\n"


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def card_description(node, by_id):
    return ("归属：" + (by_id[node["parent"]]["label"] if node.get("parent") else "独立交付/授权") +
            "\n优先级：" + node["priority"] + "；模式：" + "/".join(node["modes"]) +
            "\n要求/验收：" + node["scope"] + "\n前置：" +
            "、".join(by_id[key]["label"] for key in node.get("requires", [])) +
            "\n旧来源：" + "、".join(node.get("sources", [])) +
            "\n证据/限制：" + node.get("evidence", "未完整验收；不继承父项或原型证据") +
            "\n唯一计划数据源：docs\\POLLYOS-PLAN.json；docs\\POLLYOS-BACKLOG.md 第16节为生成视图。" +
            "\n父项完成依赖子项；子项只等待列出的具体前置，不等待父项完成。")


def sql(plan):
    nodes = list(rollup(plan["nodes"]).values())
    by_id = {node["id"]: node for node in nodes}
    statements = [
        "BEGIN TRANSACTION;",
        "CREATE TABLE IF NOT EXISTS polly_plan_nodes (id TEXT PRIMARY KEY,kind TEXT,parent_id TEXT,priority TEXT,modes TEXT,sources TEXT,scope TEXT,evidence TEXT,status TEXT);",
        "CREATE TABLE IF NOT EXISTS polly_plan_edges (todo_id TEXT,depends_on TEXT,kind TEXT,PRIMARY KEY(todo_id,depends_on,kind));",
        "CREATE TABLE IF NOT EXISTS polly_plan_origins (source_id TEXT,node_id TEXT,PRIMARY KEY(source_id,node_id));",
        "CREATE TABLE IF NOT EXISTS polly_plan_previous (id TEXT PRIMARY KEY,title TEXT,description TEXT,status TEXT,created_at TEXT,updated_at TEXT);",
        "INSERT OR IGNORE INTO polly_plan_previous SELECT id,title,description,status,created_at,updated_at FROM todos;",
        "DELETE FROM todo_deps;", "DELETE FROM todos;",
        "DELETE FROM polly_plan_edges;", "DELETE FROM polly_plan_nodes;", "DELETE FROM polly_plan_origins;",
    ]
    for node in nodes:
        description = card_description(node, by_id)
        statements.append("INSERT INTO todos(id,title,description,status) VALUES(" +
                          ",".join(quote(value) for value in (node["id"], node["label"], description, node["status"])) + ");")
        values = (node["id"], node["kind"], node.get("parent", ""), node["priority"],
                  json.dumps(node["modes"], ensure_ascii=False), json.dumps(node.get("sources", [])),
                  node["scope"], node.get("evidence", ""), node["status"])
        statements.append("INSERT INTO polly_plan_nodes VALUES(" + ",".join(quote(value) for value in values) + ");")
        for source in node["sources"]:
            statements.append("INSERT INTO polly_plan_origins VALUES(" + quote(source) + "," + quote(node["id"]) + ");")
        edges = [(key, "requires") for key in node.get("requires", [])]
        if node.get("parent"):
            edges.append((node["parent"], "parent"))
        for key, kind in edges:
            todo_id, required = (key, node["id"]) if kind == "parent" else (node["id"], key)
            statements.append("INSERT INTO polly_plan_edges VALUES(" +
                              ",".join(quote(value) for value in (todo_id, required, kind)) + ");")
    statements.extend([
        "INSERT OR IGNORE INTO todo_deps SELECT todo_id,depends_on FROM polly_plan_edges;",
        "COMMIT;",
    ])
    return "\n".join(statements) + "\n"


def database(plan, path):
    if path.exists():
        raise ValueError("Refusing to overwrite a plan import artifact")
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.executescript(
            "CREATE TABLE cards(id TEXT PRIMARY KEY,title TEXT,description TEXT,status TEXT);"
            "CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,parent_id TEXT,priority TEXT,modes TEXT,sources TEXT,scope TEXT,evidence TEXT,status TEXT);"
            "CREATE TABLE edges(todo_id TEXT,depends_on TEXT,kind TEXT,PRIMARY KEY(todo_id,depends_on,kind));"
            "CREATE TABLE origins(source_id TEXT,node_id TEXT,PRIMARY KEY(source_id,node_id));"
            "CREATE TABLE legacy(id TEXT PRIMARY KEY,requirement TEXT,status TEXT);")
        by_id = rollup(plan["nodes"])
        for node in by_id.values():
            connection.execute("INSERT INTO cards VALUES(?,?,?,?)",
                               (node["id"], node["label"], card_description(node, by_id), node["status"]))
            connection.execute("INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?)",
                               (node["id"], node["kind"], node.get("parent", ""), node["priority"],
                                json.dumps(node["modes"], ensure_ascii=False), json.dumps(node["sources"]),
                                node["scope"], node.get("evidence", ""), node["status"]))
            edges = [(node["id"], key, "requires") for key in node["requires"]]
            if node.get("parent"):
                edges.append((node["parent"], node["id"], "parent"))
            connection.executemany("INSERT INTO edges VALUES(?,?,?)", edges)
            connection.executemany("INSERT INTO origins VALUES(?,?)",
                                   ((key, node["id"]) for key in node["sources"]))
        connection.executemany("INSERT INTO legacy VALUES(?,?,?)",
                               ((key, value["requirement"], value["status"])
                                for key, value in plan["legacy"].items()))
    return path


def transfer_sql(plan):
    nodes = list(rollup(plan["nodes"]).values())
    lines = [
        "CREATE TABLE polly_stage_nodes(id TEXT PRIMARY KEY,label TEXT NOT NULL,kind TEXT,parent_id TEXT,priority TEXT,modes TEXT,sources TEXT,scope TEXT NOT NULL,evidence TEXT,status TEXT,position INTEGER);",
        "CREATE TABLE polly_stage_edges(todo_id TEXT,depends_on TEXT,kind TEXT,PRIMARY KEY(todo_id,depends_on,kind));",
        "CREATE TABLE polly_stage_origins(source_id TEXT,node_id TEXT,PRIMARY KEY(source_id,node_id));",
    ]
    for position, node in enumerate(nodes):
        scope = quote(node["scope"])
        for source in node["sources"]:
            if node["scope"] == plan["legacy"][source]["requirement"]:
                # The session holds the frozen legacy contract; formatting ticks are not scope.
                scope = "(SELECT task FROM plan_subtasks WHERE id=" + quote(source.lower().replace(".", "-")) + ")"
                break
        values = [quote(node["id"]), quote(node["label"]), quote(node["kind"]),
                  quote(node.get("parent") or ""), quote(node["priority"]),
                  quote(json.dumps(node["modes"], ensure_ascii=False)),
                  quote(json.dumps(node["sources"])), scope,
                  quote(node.get("evidence", "")), quote(node["status"]), str(position)]
        lines.append("INSERT INTO polly_stage_nodes VALUES(" + ",".join(values) + ");")
    edges, origins = [], []
    for node in nodes:
        edges.extend((node["id"], required, "requires") for required in node["requires"])
        if node.get("parent"):
            edges.append((node["parent"], node["id"], "parent"))
        origins.extend((source, node["id"]) for source in node["sources"])
    for table, rows in (("polly_stage_edges", edges), ("polly_stage_origins", origins)):
        lines.append("INSERT INTO " + table + " VALUES\n" +
                     ",\n".join("(" + ",".join(quote(value) for value in row) + ")" for row in rows) + ";")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--sql", type=Path)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--transfer-sql", type=Path)
    args = parser.parse_args()
    plan = json.loads((args.repo / "docs/POLLYOS-PLAN.json").read_text(encoding="utf8"))
    validate(plan)
    ledger = args.repo / "docs/POLLYOS-BACKLOG.md"
    before = ledger.read_text(encoding="utf8")
    marker = "## 16."
    offset = before.index(marker)
    after = before[:offset] + markdown(plan)
    if args.write:
        ledger.write_text(after, encoding="utf8", newline="\n")
        computed = rollup(plan["nodes"])
        for node in plan["nodes"]:
            node["status"] = computed[node["id"]]["status"]
        (args.repo / "docs/POLLYOS-PLAN.json").write_text(
            json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf8", newline="\n")
    elif before != after:
        raise ValueError("Execution ledger is stale; run --write")
    if args.sql:
        args.sql.write_text(sql(plan), encoding="utf8", newline="\n")
    if args.database:
        database(plan, args.database)
    if args.transfer_sql:
        args.transfer_sql.write_text(transfer_sql(plan), encoding="utf8", newline="\n")
    print(f"PASS semantic plan: {len(plan['nodes'])} nodes; all {len(plan['legacy'])} historical requirements covered; ownership/mode/prerequisite checks passed")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        print("POLLY_PLAN_FAILED: " + str(error), file=sys.stderr)
        sys.exit(1)
