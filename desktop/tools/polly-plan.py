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

    def state_label(node):
        key = node["id"]
        while key:
            if key in {"system-apps", "system-build", "system-optimizations"} and node["status"] != "done":
                return "已延期 / " + state_names[node["status"]]
            key = by_id[key].get("parent")
        return state_names[node["status"]]
    text = [
        "## 16. 完整执行清单与依赖",
        "",
        "计划数据唯一源为 `docs/POLLYOS-PLAN.json`；本节与应用 Plan 均从它生成，不分别维护状态。",
        "A0 是当前 Alpha 门槛；A1 是系统自带 App，B1 是系统构建，O1 是后期系统优化。R/T/E 的原任务 ID 和旧来源保留，归属调整不等于任务已经完成；C 是未选方向，H 是历史证据。",
        "旧 M 编号仅作来源索引，不再决定归属、顺序或依赖。拆分后的完成只承认对应组件证据，不继承整组验收。",
        "",
        "### 当前执行顺序与首个可用版本边界",
        "",
        "| 队列 | 当前交付 | 放行与并行边界 |",
        "| --- | --- | --- |",
        "| P1 / 当前 | A0 Alpha 可手测系统 | 先完成功能闭环，再统一产出一个新候选，集中手测；旧候选已可用不代表最新源码和首次图形入口已完整验收 |",
        "| 已具底座 / 保留 | R1 Live 模式；R2 启动账户；R5 基础桌面 | 原组件、来源和限制保留；Alpha 只依赖 A0 明列的具体子项，不把全系统里程碑的所有未完成项目叠成门槛 |",
        "| P2 / 自带 App | A1 系统自带 App | 基础 Files 先冻结，复制/跨目录移动/回收站与还原等强化推迟；未完成草稿不合入候选 |",
        "| P2 / 系统构建 | B1 系统构建 | 完整断网构建、CI、位级复现、渠道和正式签名身份后期单独安排；保留必要许可证和当前物料来源，不宣传已经全部履约 |",
        "| P2 / 后期项目 | O1 系统优化 | XP 精修、复测、视觉效果、XWayland、采集、硬件热插拔、有线、锁屏、共享包、多用户及授权外置安装不阻挡 Alpha；仍保持未完成/未授权状态 |",
        "| 长期完整系统 / 保留 | R3 维护与救援；R4 迁移；R6 安装写入 | 完整系统要求不删除；Alpha 虚拟候选不等于实盘安装器、独立救援、生产安全或硬件认证 |",
        "| P2 / 其它独立增强 | E 系列 | 其余增强按原具体前置独立推进，不自动成为 Alpha 门槛；休眠、加密和生产密钥保留授权边界 |",
        "| P3 / 未选方向 | C1 | 只登记方向，选择目标/范围后另立执行任务；不把全部候选变成一个必须完成的里程碑 |",
        "",
        "**依赖语义：** `归属`是完成汇总；`前置`是实际实现/验收所需的具体子项。父节点关闭依赖子节点，不反向阻塞子项开工。",
        "同一技术后端可以支撑不同交付物；跨组前置不改变归属。里程碑的进行中可以表示部分子项完成，不代表全组已开工。",
        "保持普通用户桌面、标准 PAM/passwd/su、版本配套服务账户、源/备份保留和故障显式拒绝；不整体共享 /etc 或 /var/lib。",
        "执行方式：功能代码优先，只保留必要编译/类型检查及直接小回归；功能闭环后统一候选、集中手动测试，不再为每项功能扩测试夹具/矩阵、反复构建 VM。",
        "实现、源码资格、原生组件、媒体启动和用户手测分证；完成声明只覆盖对应范围，不能把旧媒体重标为新修复或把延期标成已完成。",
        "每批更新 JSON 的状态/证据，运行 `desktop/tools/polly-plan.py --write` 生成文档并同步 Plan；仅一个重型构建/VM lane。不自动操作用户正在使用的 VM、磁盘或密码。",
        "",
    ]
    alpha_children = [node for node in nodes if node.get("parent") == "alpha"]
    if alpha_children:
        text.extend(["### Alpha 剩余工作", "",
                     "以下是当前 Alpha 的唯一门槛，不以全表任务完成比例估算版本距离。", "",
                     "| 收尾包 | 状态 | 具体边界 |", "| --- | --- | --- |"])
        for node in alpha_children:
            actual = by_id[node["id"]]
            text.append(f"| {node['label']} | {state_names[actual['status']]} | {node['scope']} |")
        text.extend(["", "版本范围、已交付介质和最短手测清单见 [Alpha 路线](POLLYOS-ALPHA.md)。", ""])
    children = {}
    for node in nodes:
        children.setdefault(node.get("parent"), []).append(node)

    def render(node, depth):
        actual = by_id[node["id"]]
        if node["kind"] in {"milestone", "catalog"}:
            text.extend(["", "### " + node["label"] + " — " + state_label(actual), "",
                         "**交付/边界：** " + node["scope"], ""])
        elif node["kind"] == "task":
            text.extend(["", "#### " + node["label"], "", node["scope"], ""])
        else:
            marker = "x" if actual["status"] == "done" else " "
            modes = "/".join(node["modes"])
            line = f"- [{marker}] **{node['label']}** · {state_label(actual)} · {node['priority']} · {modes}：{node['scope']}"
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
