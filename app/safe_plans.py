"""安全替代方案：在避开指定过敏原的前提下，为整方枚举替代组合。

候选规则（每种配料）
--------------------
- 保留「原料本身」（长度 0 的路径，无论它是否有出边）；
- 以及沿现有替代边可达的「无环终点」：路径为简单路径（不重复经过节点），
  终点出度为 0。
- 候选是否合规取决于**所选终点（最终入料）自身**是否携带禁用过敏原：
  原料本身或终点命中即排除该候选。替代的语义是用终点替换原配料，中间
  节点不会进入最终配方，因此不因中间节点含禁用过敏原而剪枝
  （路径上各节点过敏原仍随结果展示，供人工复核）。
- 命中缺失节点、回到已访问节点（成环）、超过深度上限的路径同样排除。

整方组合
--------
各配料的安全候选做笛卡尔积，使用最小堆按
(替换项数, 路径总长度) 最佳优先枚举（候选按路径长度升序，保证入堆键
单调不减），最多产出 MAX_PLANS 组——无需展开完整笛卡尔积即可保证
返回的就是排序最靠前的前 N 组，即组合搜索过程中的提前剪枝。

当某配料没有任何安全候选时整方无解（例如原料缺失，或原料自身与全部
可达无环终点都含禁用过敏原），此时返回阻塞配料及被排除候选路径的诊断。
"""
import heapq
from datetime import datetime
from typing import Any, Dict, List, Optional, Set, Tuple

from . import crud, graph
from .schemas import normalize_allergens

MAX_PLANS = 50
MAX_SAMPLE_PATHS = 10


class PlanConfirmationError(Exception):
    """确认方案校验失败：携带可直接展示给前端的结构化诊断。"""

    def __init__(self, message: str, errors: List[Dict[str, Any]]):
        super().__init__(message)
        self.message = message
        self.errors = errors


# ---------------- 单配料候选枚举 ----------------

def _node_dict(snap: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "code": snap["code"],
        "name": snap["name"],
        "allergens": list(snap["allergens"]),
        "exists": snap["exists"],
    }


def _edge_dict(edges: List[Dict[str, str]]) -> List[Dict[str, str]]:
    return [
        {"source_code": e["source_code"], "target_code": e["target_code"], "note": e.get("note", "")}
        for e in edges
    ]


def _excluded(reason: str, path, edges, trigger_node, trigger_allergens) -> Dict[str, Any]:
    return {
        "reason": reason,
        "trigger_node": trigger_node,
        "trigger_allergens": list(trigger_allergens),
        "path": [_node_dict(n) for n in path],
        "edges": _edge_dict(edges),
    }


def _make_option(path, edges) -> Dict[str, Any]:
    endpoint = path[-1]
    return {
        "selected_code": endpoint["code"],
        "selected_name": endpoint["name"],
        "path_length": len(edges),
        "path": [_node_dict(n) for n in path],
        "edges": _edge_dict(edges),
        "allergens": list(endpoint["allergens"]),
    }


def _enumerate_options(
    root_code: str,
    nodes: Dict[str, Dict[str, Any]],
    adjacency: Dict[str, List[Dict[str, str]]],
    avoid_set: Set[str],
):
    """枚举单个配料的安全候选。

    返回 (options, excluded, root_meta)：
    - options: 通过全部约束的候选（已按偏好排序）；
    - excluded: 被排除候选/分支的诊断（含禁用过敏原、缺失、循环、超深）；
    - root_meta: 原料节点是否存在、原料自身命中的禁用过敏原。
    """
    options: List[Dict[str, Any]] = []
    excluded: List[Dict[str, Any]] = []
    root = graph._node_snapshot(nodes, root_code)

    if not root["exists"]:
        excluded.append(_excluded("missing", [root], [], root_code, []))
        return options, excluded, {"exists": False, "self_forbidden": []}

    root_hits = sorted(set(root["allergens"]) & avoid_set)
    if root_hits:
        excluded.append(_excluded("forbidden", [root], [], root_code, root_hits))
    else:
        # 原料本身始终保留为候选
        options.append(_make_option([root], []))

    # 栈元素：(路径节点, 已走边)；简单路径由"目标已在路径上"判定为环
    stack: List[Tuple[List[Dict[str, Any]], List[Dict[str, str]]]] = [([root], [])]

    while stack:
        path, edges = stack.pop()
        current = path[-1]
        out = adjacency.get(current["code"], [])

        if not out:
            # 出度为 0 的无环终点（长度 0 的自身已单独收录）
            if len(path) > 1:
                hits = sorted(set(current["allergens"]) & avoid_set)
                if hits:
                    excluded.append(_excluded("forbidden", path, edges, current["code"], hits))
                else:
                    options.append(_make_option(path, edges))
            continue

        if len(edges) >= graph.MAX_DEPTH:
            excluded.append(_excluded("truncated", path, edges, None, []))
            continue

        for edge in reversed(out):  # 反转入栈以保持录入顺序优先
            target = edge["target_code"]
            new_edges = edges + [
                {"source_code": current["code"], "target_code": target, "note": edge["note"]}
            ]

            # 成环：目标已在当前路径上
            if any(n["code"] == target for n in path):
                excluded.append(
                    _excluded("cyclic", path + [graph._node_snapshot(nodes, target)], new_edges, target, [])
                )
                continue

            child = graph._node_snapshot(nodes, target)
            if not child["exists"]:
                excluded.append(_excluded("missing", path + [child], new_edges, target, []))
                continue

            # 中间节点含禁用过敏原不剪枝：更下游的无环终点仍可能安全
            stack.append((path + [child], new_edges))

    options.sort(
        key=lambda o: (
            o["path_length"],
            o["selected_code"],
            tuple(n["code"] for n in o["path"]),
        )
    )
    return options, excluded, {"exists": True, "self_forbidden": root_hits}


# ---------------- 整方最佳优先组合 ----------------

def _combine(
    options_per_item: List[List[Dict[str, Any]]],
    limit: int = MAX_PLANS,
) -> Tuple[List[Tuple[int, ...]], bool]:
    """以 (替换项数, 路径总长度) 升序，用最小堆枚举候选索引组合。

    每个配料的候选已按路径长度升序排列，因此沿"某一配料换下一个候选"
    生成后继时键值单调不减；配合 visited 去重，弹出序列即为全局有序，
    且最多只生成 limit × 配料数 数量级的状态。
    返回 (索引组合列表, 是否还有更多未产出的方案)。
    """
    n = len(options_per_item)
    if n == 0:
        return [()], False

    def key_of(idx: Tuple[int, ...]):
        sub = total = 0
        for k, j in enumerate(idx):
            length = options_per_item[k][j]["path_length"]
            total += length
            if length > 0:
                sub += 1
        return sub, total

    start = (0,) * n
    heap: List[Tuple[Tuple[int, int], Tuple[int, ...]]] = [(key_of(start), start)]
    visited = {start}
    picked: List[Tuple[int, ...]] = []

    while heap and len(picked) < limit:
        _, idx = heapq.heappop(heap)
        picked.append(idx)
        for k in range(n):
            if idx[k] + 1 < len(options_per_item[k]):
                nxt = idx[:k] + (idx[k] + 1,) + idx[k + 1:]
                if nxt not in visited:
                    visited.add(nxt)
                    heapq.heappush(heap, (key_of(nxt), nxt))

    return picked, bool(heap)


# ---------------- 响应组装 ----------------

def _blocked_entry(item, root_meta: Dict[str, Any], excluded: List[Dict[str, Any]]) -> Dict[str, Any]:
    missing = not root_meta["exists"]
    reason = "missing" if missing else "forbidden"
    counts = {"forbidden": 0, "missing": 0, "cyclic": 0, "truncated": 0}
    samples: List[Dict[str, Any]] = []
    for exc in excluded:
        if exc["reason"] in counts:
            counts[exc["reason"]] += 1
        if len(samples) < MAX_SAMPLE_PATHS:
            samples.append(exc)

    if missing:
        text = "原料节点缺失：该配料引用的原料不在原料库中，无法参与替代"
    else:
        text = (
            f"原料本身含禁用过敏原（{'、'.join(root_meta['self_forbidden'])}），"
            "且沿替代边不存在合规的无环终点"
        )
        detail = []
        if counts["forbidden"]:
            detail.append(f"{counts['forbidden']} 个无环终点含禁用过敏原")
        if counts["cyclic"]:
            detail.append(f"{counts['cyclic']} 条替代路径成环")
        if counts["missing"]:
            detail.append(f"{counts['missing']} 条替代路径到达缺失节点")
        if detail:
            text += "（" + "、".join(detail) + "）"

    return {
        "ingredient_code": item["ingredient_code"],
        "ingredient_name": item["ingredient_name"] or f"(缺失原料:{item['ingredient_code']})",
        "quantity": item["quantity"],
        "unit": item["unit"],
        "reason": reason,
        "reason_text": text,
        "self_forbidden": root_meta["self_forbidden"],
        "excluded_counts": counts,
        "samples": samples,
    }


def build_safe_plans(conn, recipe_id: int, avoid_raw: Optional[List[str]]) -> Optional[Dict[str, Any]]:
    recipe = crud.get_recipe(conn, recipe_id)
    if recipe is None:
        return None

    nodes, adjacency = graph._build_graph(conn)
    items = conn.execute(
        """SELECT ri.ingredient_code, ri.quantity, ri.unit,
                  COALESCE(i.name, '') AS ingredient_name
             FROM recipe_items ri
             LEFT JOIN ingredients i ON i.code = ri.ingredient_code
            WHERE ri.recipe_id = ?
            ORDER BY ri.id""",
        (recipe_id,),
    ).fetchall()

    avoid: List[str] = []
    for raw in avoid_raw or []:
        for allergen in normalize_allergens(raw):
            if allergen not in avoid:
                avoid.append(allergen)
    avoid_set = set(avoid)

    options_per_item: List[List[Dict[str, Any]]] = []
    blocked: List[Dict[str, Any]] = []

    for item in items:
        options, excluded, root_meta = _enumerate_options(
            item["ingredient_code"], nodes, adjacency, avoid_set
        )
        options_per_item.append(options)
        if not options:
            blocked.append(_blocked_entry(item, root_meta, excluded))

    plans: List[Dict[str, Any]] = []
    has_more = False
    if not blocked:
        chosen, has_more = _combine(options_per_item)
        for rank, idx in enumerate(chosen, start=1):
            plan_items = []
            allergen_lists: List[List[str]] = []
            sub_count = 0
            total_length = 0
            for k, item in enumerate(items):
                opt = options_per_item[k][idx[k]]
                if opt["path_length"] > 0:
                    sub_count += 1
                total_length += opt["path_length"]
                allergen_lists.append(opt["allergens"])
                plan_items.append(
                    {
                        "ingredient_code": item["ingredient_code"],
                        "ingredient_name": item["ingredient_name"]
                        or f"(缺失原料:{item['ingredient_code']})",
                        "quantity": item["quantity"],
                        "unit": item["unit"],
                        "substituted": opt["path_length"] > 0,
                        "selected_code": opt["selected_code"],
                        "selected_name": opt["selected_name"],
                        "path_length": opt["path_length"],
                        "path": opt["path"],
                        "edges": opt["edges"],
                        "allergens": opt["allergens"],
                    }
                )
            plans.append(
                {
                    "rank": rank,
                    "substitution_count": sub_count,
                    "total_path_length": total_length,
                    "allergens": graph._union(allergen_lists),
                    "items": plan_items,
                }
            )

    return {
        "recipe": {
            "id": recipe["id"],
            "code": recipe["code"],
            "version": recipe["version"],
            "name": recipe["name"],
            "note": recipe["note"],
        },
        "avoid_allergens": avoid,
        "solvable": not blocked,
        "plan_count": len(plans),
        "limit": MAX_PLANS,
        "has_more": has_more,
        "plans": plans,
        "blocked": blocked,
    }


# ---------------- 确认方案：重新校验 ----------------

def _find_path(
    nodes: Dict[str, Dict[str, Any]],
    adjacency: Dict[str, List[Dict[str, str]]],
    root_code: str,
    target_code: str,
):
    """沿现有替代边找一条 root -> target 的无环（简单）路径，BFS 取最短。

    返回 (path_nodes, edges)；root==target 时为长度 0 路径；
    目标不存在、不是无环终点（仍有出边的中间节点）或不可达
    （含仅能成环到达）时返回 None。
    """
    root = graph._node_snapshot(nodes, root_code)
    if not root["exists"]:
        return None
    if root_code == target_code:
        return [root], []
    if target_code not in nodes:
        return None
    # 与方案生成规则一致：非自身终点必须是无出边的无环终点，
    # 中间节点（即便其出边只会成环）不能作为最终入料
    if adjacency.get(target_code):
        return None

    queue: List[Tuple[List[str], List[Dict[str, str]]]] = [([root_code], [])]
    head = 0
    while head < len(queue):
        codes, edges = queue[head]
        head += 1
        if len(edges) >= graph.MAX_DEPTH:
            continue
        current = codes[-1]
        for edge in adjacency.get(current, []):
            target = edge["target_code"]
            if target in codes:
                continue  # 成环路径不能作为确认的替代路径
            new_codes = codes + [target]
            new_edges = edges + [
                {"source_code": current, "target_code": target, "note": edge.get("note", "")}
            ]
            if target == target_code:
                return [graph._node_snapshot(nodes, c) for c in new_codes], new_edges
            queue.append((new_codes, new_edges))
    return None


def _error_entry(
    error_type: str,
    message: str,
    ingredient_code: str,
    ingredient_name: str = "",
    selected_code: Optional[str] = None,
    trigger_allergens: Optional[List[str]] = None,
    blocked: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    entry = {
        "type": error_type,
        "message": message,
        "ingredient_code": ingredient_code,
        "ingredient_name": ingredient_name,
        "selected_code": selected_code,
        "trigger_allergens": trigger_allergens or [],
    }
    if blocked is not None:
        entry["blocked"] = blocked
    return entry


def confirm_plan(
    conn,
    recipe_id: int,
    avoid_raw: Optional[List[str]],
    selections_raw: List[Dict[str, str]],
) -> Optional[Dict[str, Any]]:
    """校验用户选定的方案并生成合并后的采购清单。

    校验基于**当前数据库快照**重新执行（而非信任生成时的结果）：
    - selections 按配方配料行顺序逐行对应（同一原料可在配方中占多行），
      少传 / 多传 / 配料错位都按结构错误返回；
    - 所选终点沿现有替代边存在无环简单路径可达：原料本身为长度 0，
      非自身终点还必须是无出边的无环终点（中间节点不可作为最终入料）；
    - 终点原料存在，且其自身过敏原不命中需避开的过敏原。
    任一不满足即抛 PlanConfirmationError（携带逐项结构化诊断）。
    """
    recipe = crud.get_recipe(conn, recipe_id)
    if recipe is None:
        return None

    nodes, adjacency = graph._build_graph(conn)
    items = conn.execute(
        """SELECT ri.ingredient_code, ri.quantity, ri.unit,
                  COALESCE(i.name, '') AS ingredient_name
             FROM recipe_items ri
             LEFT JOIN ingredients i ON i.code = ri.ingredient_code
            WHERE ri.recipe_id = ?
            ORDER BY ri.id""",
        (recipe_id,),
    ).fetchall()

    avoid: List[str] = []
    for raw in avoid_raw or []:
        for allergen in normalize_allergens(raw):
            if allergen not in avoid:
                avoid.append(allergen)
    avoid_set = set(avoid)

    errors: List[Dict[str, Any]] = []

    # 1) 结构校验：选择按**配料行顺序**逐行对应（同一原料在配方中可能出现多行，
    #    如分两次投料的 100g + 50g；前端提交的就是生成方案时的 plan.items 顺序）。
    n_items = len(items)
    n_sel = len(selections_raw)
    chosen: List[Optional[str]] = [None] * n_items

    for i, sel in enumerate(selections_raw):
        if i >= n_items:
            errors.append(
                _error_entry(
                    "extra_selection",
                    f"第 {i + 1} 条选择超出当前配方配料数量，配方在方案生成后可能已变更，请重新生成方案",
                    sel["ingredient_code"],
                    "",
                    sel["selected_code"],
                )
            )
            continue
        item = items[i]
        if sel["ingredient_code"] != item["ingredient_code"]:
            errors.append(
                _error_entry(
                    "selection_mismatch",
                    f"第 {i + 1} 个配料应为 {item['ingredient_code']}，"
                    f"提交的却是 {sel['ingredient_code']}，配方在方案生成后可能已变更，请重新生成方案",
                    item["ingredient_code"],
                    item["ingredient_name"],
                    sel["selected_code"],
                )
            )
            continue
        chosen[i] = sel["selected_code"]

    for i, item in enumerate(items):
        if i >= n_sel:
            errors.append(
                _error_entry(
                    "missing_selection",
                    f"第 {i + 1} 个配料 {item['ingredient_name'] or item['ingredient_code']}"
                    f"（{item['ingredient_code']}）缺少选择，请为其指定一个终点原料",
                    item["ingredient_code"],
                    item["ingredient_name"],
                )
            )

    # 2) 逐行重新校验终点：存在性 / 可达性 / 过敏原约束
    confirmed: List[Dict[str, Any]] = []
    for i, item in enumerate(items):
        code = item["ingredient_code"]
        target = chosen[i]
        if target is None:
            continue  # 已记 missing_selection / mismatch

        root_snap = graph._node_snapshot(nodes, code)
        target_snap = graph._node_snapshot(nodes, target)

        def _blocked_diag():
            options, excluded, root_meta = _enumerate_options(code, nodes, adjacency, avoid_set)
            if options:
                return None
            return _blocked_entry(item, root_meta, excluded)

        if not root_snap["exists"]:
            errors.append(
                _error_entry(
                    "missing",
                    f"配料 {code} 引用的原料在原料库中缺失，无法参与替代与采购",
                    code,
                    item["ingredient_name"],
                    target,
                    blocked=_blocked_diag(),
                )
            )
            continue
        if not target_snap["exists"]:
            errors.append(
                _error_entry(
                    "missing",
                    f"所选终点原料 {target} 在原料库中不存在（缺失节点），无法采购",
                    code,
                    item["ingredient_name"],
                    target,
                    blocked=_blocked_diag(),
                )
            )
            continue

        found = _find_path(nodes, adjacency, code, target)
        if found is None:
            errors.append(
                _error_entry(
                    "unreachable",
                    f"配料 {code} 无法沿现有替代边（无环）到达所选原料 {target}，请重新选择",
                    code,
                    item["ingredient_name"],
                    target,
                    blocked=_blocked_diag(),
                )
            )
            continue

        path_nodes, path_edges = found
        endpoint = path_nodes[-1]
        hits = sorted(set(endpoint["allergens"]) & avoid_set)
        if hits:
            errors.append(
                _error_entry(
                    "forbidden",
                    f"所选原料 {target} 含需避开的过敏原（{'、'.join(hits)}），校验未通过",
                    code,
                    item["ingredient_name"],
                    target,
                    trigger_allergens=hits,
                    blocked=_blocked_diag(),
                )
            )
            continue

        confirmed.append(
            {
                "ingredient_code": code,
                "ingredient_name": item["ingredient_name"] or f"(缺失原料:{code})",
                "quantity": item["quantity"],
                "unit": item["unit"],
                "substituted": len(path_edges) > 0,
                "selected_code": target,
                "selected_name": endpoint["name"],
                "path_length": len(path_edges),
                "path": [_node_dict(n) for n in path_nodes],
                "edges": _edge_dict(path_edges),
                "path_chain": " → ".join(n["code"] for n in path_nodes),
                "allergens": list(endpoint["allergens"]),
            }
        )

    if errors:
        raise PlanConfirmationError(
            f"方案校验未通过：{len(errors)} 个配料的选择不再满足避开过敏原等约束",
            errors,
        )

    return _build_confirmation(recipe, avoid, confirmed)


# ---------------- 采购清单合并 ----------------

def _clean_number(value):
    if value is None:
        return None
    num = round(float(value), 6)
    return int(num) if num == int(num) else num


def _source_label(source: Dict[str, Any]) -> str:
    qty = source["quantity"]
    return f"{source['ingredient_code']} {source['ingredient_name']}（{qty if qty is not None else '用量未登记'}{source['unit'] or ''}）"


def _build_confirmation(
    recipe,
    avoid: List[str],
    items: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """按所选终点合并相同原料：同单位数量相加，不同单位分行并给出说明。"""
    # group: selected_code -> 聚合状态
    groups: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []

    for source in items:
        code = source["selected_code"]
        group = groups.get(code)
        if group is None:
            group = {
                "selected_code": code,
                "selected_name": source["selected_name"],
                "allergens": list(source["allergens"]),
                "buckets": {},       # unit_key -> {"unit", "order", "sources", "total"}
                "no_qty": [],        # 未登记用量的来源（各自成行）
                "unit_keys": set(),
            }
            groups[code] = group
            order.append(code)
        group["unit_keys"].add((source["unit"] or "").strip().casefold())
        qty = _clean_number(source["quantity"])
        ref = {
            "ingredient_code": source["ingredient_code"],
            "ingredient_name": source["ingredient_name"],
            "quantity": qty,
            "unit": source["unit"],
        }
        if qty is None:
            group["no_qty"].append(ref)
        else:
            key = (source["unit"] or "").strip().casefold()
            bucket = group["buckets"].get(key)
            if bucket is None:
                bucket = {"unit": (source["unit"] or "").strip(), "sources": [], "total": 0.0}
                group["buckets"][key] = bucket
            bucket["sources"].append(ref)
            bucket["total"] += qty

    lines: List[Dict[str, Any]] = []
    merge_notes: List[str] = []
    seq = 0
    for code in order:
        group = groups[code]
        endpoint = f"{group['selected_name']}（{group['selected_code']}）"

        unit_warning = ""
        if len(group["unit_keys"]) > 1:
            unit_warning = (
                f"注意：{endpoint} 在各配料中存在不同单位，已按单位分行，"
                "未做跨单位换算合并，请人工核对"
            )
            merge_notes.append(unit_warning)

        for bucket in group["buckets"].values():
            seq += 1
            total = _clean_number(bucket["total"])
            merged = len(bucket["sources"]) > 1
            note = ""
            if merged:
                note = (
                    f"由 {len(bucket['sources'])} 个配料合并："
                    + "、".join(_source_label({**s, "unit": bucket["unit"]}) for s in bucket["sources"])
                    + "，相同单位数量已相加"
                )
            if unit_warning:
                note = (note + "；" if note else "") + unit_warning
            lines.append(
                {
                    "seq": seq,
                    "selected_code": group["selected_code"],
                    "selected_name": group["selected_name"],
                    "quantity": total,
                    "unit": bucket["unit"],
                    "allergens": list(group["allergens"]),
                    "merged": merged,
                    "merged_from": bucket["sources"],
                    "merge_note": note,
                }
            )

        for ref in group["no_qty"]:
            seq += 1
            note = f"{_source_label(ref)} 未登记用量，未参与数量合并，请按实际需要采购"
            merge_notes.append(note)
            if unit_warning:
                note += "；" + unit_warning
            lines.append(
                {
                    "seq": seq,
                    "selected_code": group["selected_code"],
                    "selected_name": group["selected_name"],
                    "quantity": None,
                    "unit": ref["unit"] or "",
                    "allergens": list(group["allergens"]),
                    "merged": False,
                    "merged_from": [ref],
                    "merge_note": note,
                }
            )

    substitution_count = sum(1 for it in items if it["substituted"])
    all_allergens = graph._union([it["allergens"] for it in items])
    return {
        "recipe": {
            "id": recipe["id"],
            "code": recipe["code"],
            "version": recipe["version"],
            "name": recipe["name"],
            "note": recipe["note"],
        },
        "avoid_allergens": avoid,
        "validated_at": datetime.now().isoformat(timespec="seconds"),
        "summary": {
            "item_count": len(items),
            "substitution_count": substitution_count,
            "purchase_line_count": len(lines),
            "allergens": all_allergens,
        },
        "items": items,
        "shopping_list": {
            "title": f"采购清单 · {recipe['code']} v{recipe['version']} {recipe['name']}",
            "lines": lines,
            "merge_notes": merge_notes,
        },
    }
