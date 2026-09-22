/* 配方替代过敏原追踪 —— 原生 JS 前端 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------- 基础工具 ----------------

async function api(path, options = {}) {
  const opts = { headers: { "Content-Type": "application/json" }, ...options };
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data && data.detail;
    if (detail && typeof detail === "object") {
      const err = new Error(detail.message || `HTTP ${res.status}`);
      err.payload = detail;
      throw err;
    }
    const message = detail ? (typeof detail === "string" ? detail : JSON.stringify(detail)) : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function allergenTags(list, cls = "allergen") {
  if (!list || !list.length) return '<span class="tag muted">无</span>';
  return list.map((a) => `<span class="tag ${cls}">${esc(a)}</span>`).join("");
}

// ---------------- Tab 切换 ----------------

$$("#tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$("#tabs .tab").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------------- 全局数据缓存 ----------------

const state = {
  ingredients: [],
  substitutions: [],
  recipes: [],
};

async function refreshAll() {
  await Promise.all([loadIngredients(), loadSubstitutions(), loadRecipes()]);
  fillIngredientSelects();
  fillRecipeSelects();
}

// ---------------- 原料 ----------------

async function loadIngredients() {
  state.ingredients = await api("/api/ingredients");
  const tbody = $("#tbody-ingredients");
  if (!state.ingredients.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无原料，请新增或在「导入导出」页载入示例数据</td></tr>';
    return;
  }
  tbody.innerHTML = state.ingredients.map((i) => `
    <tr>
      <td class="code-mono">${esc(i.code)}</td>
      <td>${esc(i.name)}</td>
      <td>${allergenTags(i.allergen_list)}</td>
      <td>${esc(i.note)}</td>
      <td>
        <button class="btn tiny" data-act="edit-ing" data-code="${esc(i.code)}">编辑</button>
        <button class="btn tiny danger" data-act="del-ing" data-code="${esc(i.code)}">删除</button>
      </td>
    </tr>`).join("");
}

$("#btn-new-ingredient").addEventListener("click", () => {
  $("#form-ingredient").classList.remove("hidden");
  $("#ing-orig-code").value = "";
  ["ing-code", "ing-name", "ing-allergens", "ing-note"].forEach((id) => ($("#" + id).value = ""));
  $("#ing-code").disabled = false;
  $("#ing-code").focus();
});

$("#btn-cancel-ingredient").addEventListener("click", () => $("#form-ingredient").classList.add("hidden"));

$("#form-ingredient").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    code: $("#ing-code").value.trim(),
    name: $("#ing-name").value.trim(),
    allergens: $("#ing-allergens").value.trim(),
    note: $("#ing-note").value.trim(),
  };
  const orig = $("#ing-orig-code").value;
  try {
    if (orig) {
      await api(`/api/ingredients/${encodeURIComponent(orig)}`, { method: "PUT", body });
      toast("原料已更新");
    } else {
      await api("/api/ingredients", { method: "POST", body });
      toast("原料已创建");
    }
    $("#form-ingredient").classList.add("hidden");
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#tbody-ingredients").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const code = btn.dataset.code;
  if (btn.dataset.act === "edit-ing") {
    const ing = state.ingredients.find((x) => x.code === code);
    $("#form-ingredient").classList.remove("hidden");
    $("#ing-orig-code").value = code;
    $("#ing-code").value = ing.code;
    $("#ing-name").value = ing.name;
    $("#ing-allergens").value = ing.allergen_list.join(", ");
    $("#ing-note").value = ing.note;
    $("#ing-code").disabled = false;
  } else if (btn.dataset.act === "del-ing") {
    if (!confirm(`确定删除原料 ${code}？相关替代边也会被移除。`)) return;
    try {
      await api(`/api/ingredients/${encodeURIComponent(code)}`, { method: "DELETE" });
      toast("已删除");
      await refreshAll();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

// ---------------- 替代关系 ----------------

function fillIngredientSelects() {
  const opts = state.ingredients
    .map((i) => `<option value="${esc(i.code)}">${esc(i.code)} · ${esc(i.name)}</option>`)
    .join("");
  $("#sub-source").innerHTML = opts;
  $("#sub-target").innerHTML = opts;
}

async function loadSubstitutions() {
  state.substitutions = await api("/api/substitutions");
  const tbody = $("#tbody-substitutions");
  if (!state.substitutions.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无替代关系</td></tr>';
    return;
  }
  tbody.innerHTML = state.substitutions.map((s) => {
    const added = s.target_allergens.filter((a) => !s.source_allergens.includes(a));
    const removed = s.source_allergens.filter((a) => !s.target_allergens.includes(a));
    let change = "";
    if (added.length) change += added.map((a) => `<span class="tag new">+${esc(a)}</span>`).join("");
    if (removed.length) change += removed.map((a) => `<span class="tag muted">−${esc(a)}</span>`).join("");
    if (!change) change = '<span class="tag muted">过敏原无变化</span>';
    return `
    <tr>
      <td class="code-mono">${esc(s.source_code)}<br><small>${esc(s.source_name)}</small></td>
      <td class="arrow">→</td>
      <td class="code-mono">${esc(s.target_code)}<br><small>${esc(s.target_name)}</small></td>
      <td>${change}</td>
      <td>${esc(s.note)}</td>
      <td><button class="btn tiny danger" data-act="del-sub" data-id="${s.id}">删除</button></td>
    </tr>`;
  }).join("");
}

$("#form-substitution").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    source_code: $("#sub-source").value,
    target_code: $("#sub-target").value,
    note: $("#sub-note").value.trim(),
  };
  try {
    await api("/api/substitutions", { method: "POST", body });
    toast("替代边已添加");
    $("#sub-note").value = "";
    await loadSubstitutions();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#tbody-substitutions").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.dataset.act !== "del-sub") return;
  if (!confirm("确定删除该替代关系？")) return;
  try {
    await api(`/api/substitutions/${btn.dataset.id}`, { method: "DELETE" });
    toast("已删除");
    await loadSubstitutions();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------- 配方版本 ----------------

async function loadRecipes() {
  state.recipes = await api("/api/recipes");
  const tbody = $("#tbody-recipes");
  if (!state.recipes.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无配方版本</td></tr>';
    return;
  }
  tbody.innerHTML = state.recipes.map((r) => `
    <tr>
      <td class="code-mono">${esc(r.code)}</td>
      <td>${esc(r.version)}</td>
      <td>${esc(r.name)}</td>
      <td>${r.item_count}</td>
      <td><small>${esc(r.created_at)}</small></td>
      <td>
        <button class="btn tiny" data-act="edit-rec" data-id="${r.id}">编辑</button>
        <button class="btn tiny danger" data-act="del-rec" data-id="${r.id}">删除</button>
      </td>
    </tr>`).join("");
}

function itemRowHtml(item = { ingredient_code: "", quantity: "", unit: "" }) {
  const opts = state.ingredients
    .map((i) => `<option value="${esc(i.code)}" ${i.code === item.ingredient_code ? "selected" : ""}>${esc(i.code)} · ${esc(i.name)}</option>`)
    .join("");
  return `
    <tr>
      <td><select class="item-code">${opts}</select></td>
      <td><input class="item-qty" type="number" step="any" value="${item.quantity ?? ""}" style="width:90px" /></td>
      <td><input class="item-unit" value="${esc(item.unit || "")}" style="width:80px" placeholder="g" /></td>
      <td><button type="button" class="btn tiny danger item-del">移除</button></td>
    </tr>`;
}

$("#btn-add-item").addEventListener("click", () => {
  $("#tbody-items").insertAdjacentHTML("beforeend", itemRowHtml());
});

$("#tbody-items").addEventListener("click", (e) => {
  if (e.target.classList.contains("item-del")) e.target.closest("tr").remove();
});

$("#btn-new-recipe").addEventListener("click", () => {
  $("#form-recipe").classList.remove("hidden");
  $("#rec-id").value = "";
  ["rec-code", "rec-version", "rec-name", "rec-note"].forEach((id) => ($("#" + id).value = ""));
  $("#tbody-items").innerHTML = itemRowHtml();
  $("#form-recipe").scrollIntoView({ behavior: "smooth" });
});

$("#btn-cancel-recipe").addEventListener("click", () => $("#form-recipe").classList.add("hidden"));

function collectRecipeBody() {
  const items = $$("#tbody-items tr").map((tr) => ({
    ingredient_code: tr.querySelector(".item-code").value,
    quantity: tr.querySelector(".item-qty").value === "" ? null : Number(tr.querySelector(".item-qty").value),
    unit: tr.querySelector(".item-unit").value.trim(),
  })).filter((x) => x.ingredient_code);
  return {
    code: $("#rec-code").value.trim(),
    version: $("#rec-version").value.trim(),
    name: $("#rec-name").value.trim(),
    note: $("#rec-note").value.trim(),
    items,
  };
}

$("#form-recipe").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = collectRecipeBody();
  const id = $("#rec-id").value;
  try {
    if (id) {
      await api(`/api/recipes/${id}`, { method: "PUT", body });
      toast("配方已更新");
    } else {
      await api("/api/recipes", { method: "POST", body });
      toast("配方已创建");
    }
    $("#form-recipe").classList.add("hidden");
    await loadRecipes();
    fillRecipeSelects();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#tbody-recipes").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === "edit-rec") {
    const rec = await api(`/api/recipes/${id}`);
    $("#form-recipe").classList.remove("hidden");
    $("#rec-id").value = rec.id;
    $("#rec-code").value = rec.code;
    $("#rec-version").value = rec.version;
    $("#rec-name").value = rec.name;
    $("#rec-note").value = rec.note;
    $("#tbody-items").innerHTML = rec.items.length
      ? rec.items.map((it) => itemRowHtml(it)).join("")
      : itemRowHtml();
    $("#form-recipe").scrollIntoView({ behavior: "smooth" });
  } else if (btn.dataset.act === "del-rec") {
    if (!confirm("确定删除该配方版本？")) return;
    try {
      await api(`/api/recipes/${id}`, { method: "DELETE" });
      toast("已删除");
      await loadRecipes();
      fillRecipeSelects();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

// ---------------- 配方下拉 ----------------

function recipeOptions(selectEl, includeAllVersions = true) {
  const groups = {};
  state.recipes.forEach((r) => {
    (groups[r.code] ||= []).push(r);
  });
  selectEl.innerHTML = Object.entries(groups).map(([code, rs]) => `
    <optgroup label="${esc(code)}">
      ${rs.map((r) => `<option value="${r.id}">v${esc(r.version)} · ${esc(r.name)}</option>`).join("")}
    </optgroup>`).join("");
}

function fillRecipeSelects() {
  recipeOptions($("#analyze-recipe"));
  recipeOptions($("#safe-recipe"));
  recipeOptions($("#cmp-a"));
  recipeOptions($("#cmp-b"));
  if (state.recipes.length >= 2) {
    $("#cmp-a").selectedIndex = 0;
    $("#cmp-b").selectedIndex = 1;
  }
}

// ---------------- 过敏原分析渲染 ----------------

function renderPath(path) {
  const nodeSpans = path.nodes.map((n, idx) => {
    const isLast = idx === path.nodes.length - 1;
    const repeat = path.cyclic && isLast;
    const cls = ["path-node"];
    if (isLast && !path.cyclic) cls.push("terminal");
    if (repeat) cls.push("repeat");
    const al = n.allergens.length ? `<span class="al">[${esc(n.allergens.join(","))}]</span>` : "";
    return `<span class="${cls.join(" ")}">${esc(n.code)}${al}</span>`;
  });
  let html = nodeSpans[0] || "";
  for (let i = 1; i < path.nodes.length; i++) {
    html += `<span class="path-edge"> → </span>` + nodeSpans[i];
  }

  const meta = [];
  meta.push(`<span class="path-id">#${path.id}</span>`);
  if (path.cyclic) meta.push(`<span class="badge cycle">循环! 回到 ${esc(path.cycle_node)}</span>`);
  if (path.missing) meta.push(`<span class="badge missing">缺失节点</span>`);
  if (path.truncated) meta.push(`<span class="badge missing">已达深度上限</span>`);
  if (path.terminal) meta.push(`<span class="tag ok">终止路径</span>`);
  if (path.new_allergens.length) meta.push(`<span class="tag new">经替代引入: ${esc(path.new_allergens.join(", "))}</span>`);

  return `<div class="path-line ${path.cyclic ? "cyclic" : path.missing ? "missing" : ""}">
    ${html}<span class="path-meta">${meta.join(" ")}</span></div>`;
}

function renderAnalysis(data) {
  const r = data.recipe;
  let html = `
    <div class="summary-bar">
      <div class="summary-box"><h4>配方</h4><strong>${esc(r.code)}</strong> v${esc(r.version)}<br><small>${esc(r.name)}</small></div>
      <div class="summary-box"><h4>直接过敏原</h4>${allergenTags(data.direct_allergens, "direct")}</div>
      <div class="summary-box"><h4>含替代链的全部过敏原</h4>${allergenTags(data.total_allergens, "allergen")}</div>
      <div class="summary-box"><h4>替代新引入</h4>${allergenTags(data.introduced_allergens, "new")}</div>
    </div>`;

  if (data.has_cycles) {
    html += `<div class="alert cycle"><strong>⚠ 检测到 ${data.cycles.length} 条循环替代路径：</strong><ul>`;
    html += data.cycles.map((c) =>
      `<li>路径 #${c.path_id}（起点 <span class="code-mono">${esc(c.root)}</span>）在 <span class="code-mono">${esc(c.cycle_node)}</span> 处成环：${c.nodes.map(esc).join(" → ")}</li>`
    ).join("");
    html += `</ul></div>`;
  }
  if (data.missing_nodes.length) {
    html += `<div class="alert warn"><strong>⚠ 存在缺失原料节点：</strong>${data.missing_nodes.map(esc).join("、")}（请在原料库补录）</div>`;
  }

  for (const root of data.roots) {
    const cyclicPaths = root.paths.filter((p) => p.cyclic).length;
    html += `<div class="root-block ${root.has_cycle ? "has-cycle" : ""}">
      <div class="root-title">
        <span class="code-mono">${esc(root.ingredient_code)}</span>
        <span>${esc(root.ingredient_name)}${root.quantity != null ? ` · ${root.quantity}${esc(root.unit || "")}` : ""}</span>
        ${root.has_cycle ? `<span class="badge cycle">含 ${cyclicPaths} 条循环路径</span>` : ""}
        ${!root.exists ? `<span class="badge missing">原料缺失</span>` : ""}
      </div>
      <div style="margin:6px 0">
        直接：${allergenTags(root.direct_allergens, "direct")}
        替代链总计：${allergenTags(root.total_allergens, "allergen")}
        ${root.introduced_allergens.length ? `新引入：${allergenTags(root.introduced_allergens, "new")}` : ""}
      </div>`;

    // 过敏原 -> 受影响路径表
    const idxEntries = Object.entries(root.allergen_index);
    if (idxEntries.length) {
      html += `<details><summary>过敏原受影响路径索引（${idxEntries.length} 种过敏原）</summary>
        <table class="data-table allergen-table" style="margin-top:8px">
          <thead><tr><th>过敏原</th><th>携带该过敏原的路径</th><th>路径数</th></tr></thead><tbody>`;
      html += idxEntries.map(([al, refs]) => `
        <tr>
          <td><span class="tag allergen">${esc(al)}</span></td>
          <td>${refs.map((p) => `<span class="tag ${p.via_substitution ? "new" : "direct"}">#${p.path_id} ${p.chain.map(esc).join("→")}${p.via_substitution ? `（由 ${esc(p.introduced_by)} 引入）` : ""}</span>`).join(" ")}</td>
          <td>${refs.length}</td>
        </tr>`).join("");
      html += `</tbody></table></details>`;
    }

    html += `<div class="path-list">${root.paths.map(renderPath).join("")}</div></div>`;
  }

  $("#analyze-result").innerHTML = html;
}

$("#btn-analyze").addEventListener("click", async () => {
  const id = $("#analyze-recipe").value;
  if (!id) return toast("请先选择配方", true);
  try {
    const data = await api(`/api/recipes/${id}/analyze`);
    renderAnalysis(data);
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------- 安全替代方案 ----------------

const safeState = {
  allergens: [],
  checked: new Set(),
  plansData: null,
  selectedRank: null,
  shoppingList: null,
};

function renderSafeAllergenChecks() {
  const box = $("#safe-allergens");
  if (!safeState.allergens.length) {
    box.innerHTML = '<span class="hint">该配方暂无可列出的过敏原，可在下方手动添加。</span>';
    return;
  }
  box.innerHTML = safeState.allergens.map((a) => `
    <label class="allergen-check">
      <input type="checkbox" value="${esc(a)}" ${safeState.checked.has(a) ? "checked" : ""} />
      <span class="tag allergen">${esc(a)}</span>
    </label>`).join("");
}

async function loadSafeAllergens() {
  const id = $("#safe-recipe").value;
  if (!id) {
    safeState.allergens = [];
    renderSafeAllergenChecks();
    return;
  }
  try {
    const data = await api(`/api/recipes/${id}/analyze`);
    const known = new Set(safeState.allergens);
    const fresh = [];
    for (const root of data.roots) {
      for (const a of root.total_allergens) {
        if (!known.has(a)) { known.add(a); fresh.push(a); }
      }
    }
    safeState.allergens = safeState.allergens.filter((a) => known.has(a)).concat(fresh);
    renderSafeAllergenChecks();
  } catch (err) {
    toast(err.message, true);
  }
}

$("#safe-recipe").addEventListener("change", () => {
  loadSafeAllergens();
  // 配方切换后旧方案/确认结果失效
  safeState.plansData = null;
  safeState.selectedRank = null;
  safeState.shoppingList = null;
  $("#safe-result").innerHTML = "";
  $("#safe-confirmed").innerHTML = "";
  updateSafeConfirmBar();
});

$("#safe-allergens").addEventListener("change", (e) => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (!cb) return;
  if (cb.checked) safeState.checked.add(cb.value);
  else safeState.checked.delete(cb.value);
});

$("#btn-safe-add-allergen").addEventListener("click", () => {
  const input = $("#safe-allergen-custom");
  const value = input.value.trim();
  if (!value) return;
  value.replace("、", ",").split(",").map((s) => s.trim()).filter(Boolean).forEach((a) => {
    if (!safeState.allergens.includes(a)) safeState.allergens.push(a);
    safeState.checked.add(a);
  });
  input.value = "";
  renderSafeAllergenChecks();
});

$("#safe-allergen-custom").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("#btn-safe-add-allergen").click(); }
});

function safePathChain(path, triggerNode = null) {
  return path.map((n, i) => {
    const isLast = i === path.length - 1;
    const cls = ["path-node"];
    if (isLast) cls.push("terminal");
    if (triggerNode && n.code === triggerNode) cls.push("repeat");
    if (!n.exists) cls.push("missing-node");
    const al = n.allergens.length ? `<span class="al">[${esc(n.allergens.join(","))}]</span>` : "";
    return `<span class="${cls.join(" ")}">${esc(n.code)}${al}</span>`;
  }).join('<span class="path-edge"> → </span>');
}

const EXCLUSION_REASON_LABEL = {
  forbidden: "含禁用过敏原",
  missing: "缺失节点",
  cyclic: "循环路径",
  truncated: "超深度上限",
};

function renderBlocked(blocked) {
  return `<div class="alert cycle">
      <strong>⚠ 无安全方案：以下 ${blocked.length} 种配料找不到任何合规候选：</strong>
    </div>` + blocked.map((b) => {
      let samples = "";
      const total = Object.values(b.excluded_counts).reduce((s, v) => s + v, 0);
      if (total > 0) {
        samples = `<details><summary>查看被排除的候选路径（${total} 条，示例 ${b.samples.length} 条）</summary><div class="path-list">`;
        samples += b.samples.map((s) => {
          const label = EXCLUSION_REASON_LABEL[s.reason] || s.reason;
          const trigger = s.reason === "forbidden" ? s.trigger_node : null;
          const extra = s.reason === "forbidden" && s.trigger_allergens.length
            ? `（${esc(s.trigger_allergens.join("、"))}）` : "";
          return `<div class="path-line ${s.reason === "missing" ? "missing" : "cyclic"}">
            ${safePathChain(s.path, trigger)}
            <span class="path-meta"><span class="badge ${s.reason === "missing" ? "missing" : "cycle"}">${esc(label)}${extra}</span></span>
          </div>`;
        }).join("");
        samples += `</div></details>`;
      }
      return `<div class="root-block blocked-block">
        <div class="root-title">
          <span class="code-mono">${esc(b.ingredient_code)}</span>
          <span>${esc(b.ingredient_name)}${b.quantity != null ? ` · ${b.quantity}${esc(b.unit || "")}` : ""}</span>
          <span class="badge ${b.reason === "missing" ? "missing" : "cycle"}">阻塞配料</span>
        </div>
        <div class="blocked-reason">${esc(b.reason_text)}</div>
        ${samples}
      </div>`;
    }).join("");
}

function renderSafePlans(data) {
  safeState.plansData = data;
  safeState.selectedRank = null;
  safeState.shoppingList = null;
  $("#safe-confirmed").innerHTML = "";
  const avoid = data.avoid_allergens.length
    ? allergenTags(data.avoid_allergens, "direct")
    : '<span class="tag muted">未勾选（返回原方）</span>';

  let html = `
    <div class="summary-bar">
      <div class="summary-box"><h4>配方</h4><strong>${esc(data.recipe.code)}</strong> v${esc(data.recipe.version)}<br><small>${esc(data.recipe.name)}</small></div>
      <div class="summary-box"><h4>避开的过敏原</h4>${avoid}</div>
      <div class="summary-box"><h4>安全方案数</h4><strong>${data.plan_count}</strong> 组${data.has_more ? `<small>（超过 ${data.limit} 组上限，仅展示排序最靠前的 ${data.limit} 组）</small>` : ""}</div>
      <div class="summary-box"><h4>排序规则</h4><small>替换项数 ↑ · 路径总长度 ↑</small></div>
    </div>`;

  if (!data.solvable) {
    $("#safe-result").innerHTML = html + renderBlocked(data.blocked);
    $("#safe-confirm-bar").classList.add("hidden");
    return;
  }

  html += data.plans.map((p) => {
    const body = `
      <table class="data-table plan-table">
        <thead><tr><th>配料</th><th>所选原料</th><th>替代路径</th><th>路径长度</th><th>过敏原</th></tr></thead>
        <tbody>
          ${p.items.map((it) => `
            <tr class="${it.substituted ? "row-substituted" : ""}">
              <td><span class="code-mono">${esc(it.ingredient_code)}</span><br><small>${esc(it.ingredient_name)}${it.quantity != null ? ` · ${it.quantity}${esc(it.unit || "")}` : ""}</small></td>
              <td><span class="code-mono">${esc(it.selected_code)}</span><br><small>${esc(it.selected_name)}</small>${it.substituted ? ' <span class="tag new">已替代</span>' : ' <span class="tag ok">保留原方</span>'}</td>
              <td><div class="path-line" style="border:none;background:none;padding:0">${safePathChain(it.path)}</div></td>
              <td>${it.path_length}</td>
              <td>${allergenTags(it.allergens)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <div class="plan-allergens">整方过敏原：${allergenTags(p.allergens)}</div>`;
    return `
      <details class="card plan-card" ${p.rank === 1 ? "open" : ""}>
        <summary>
          <label class="plan-pick" data-rank="${p.rank}" title="选择此方案">
            <input type="radio" name="safe-plan-pick" value="${p.rank}" />
            <span>选择此方案</span>
          </label>
          <span class="plan-rank">#${p.rank}</span>
          <span class="tag ${p.substitution_count ? "new" : "ok"}">替换 ${p.substitution_count} 项</span>
          <span class="tag muted">路径总长度 ${p.total_path_length}</span>
          <span class="plan-summary-allergens">${allergenTags(p.allergens)}</span>
        </summary>
        ${body}
      </details>`;
  }).join("");

  $("#safe-result").innerHTML = html;
  updateSafeConfirmBar();
}

$("#btn-safe-search").addEventListener("click", async () => {
  const id = $("#safe-recipe").value;
  if (!id) return toast("请先选择配方", true);
  try {
    const data = await api(`/api/recipes/${id}/safe-plans`, {
      method: "POST",
      body: { avoid_allergens: Array.from(safeState.checked) },
    });
    renderSafePlans(data);
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------- 方案确认与采购清单 ----------------

function updateSafeConfirmBar() {
  const bar = $("#safe-confirm-bar");
  const btn = $("#btn-safe-confirm");
  if (safeState.plansData && safeState.plansData.solvable) {
    bar.classList.remove("hidden");
  } else {
    bar.classList.add("hidden");
  }
  if (safeState.selectedRank) {
    btn.disabled = false;
    $("#safe-confirm-bar").querySelector(".confirm-picked").innerHTML =
      `已选择方案 <strong>#${safeState.selectedRank}</strong>`;
  } else {
    btn.disabled = true;
    $("#safe-confirm-bar").querySelector(".confirm-picked").textContent = "尚未选择方案";
  }
}

// 方案单选（点击 label 时阻止冒泡，避免折叠 details）
$("#safe-result").addEventListener("click", (e) => {
  const label = e.target.closest(".plan-pick");
  if (!label) return;
  e.preventDefault();
  e.stopPropagation();
  const radio = label.querySelector('input[type="radio"]');
  radio.checked = true;
  safeState.selectedRank = Number(radio.value);
  $$('.plan-pick input[name="safe-plan-pick"]').forEach((r) =>
    r.closest(".plan-card").classList.toggle("picked", r.checked));
  updateSafeConfirmBar();
});

const CONFIRM_ERROR_LABEL = {
  forbidden: "含禁用过敏原",
  missing: "原料缺失",
  unreachable: "终点不可达",
  missing_selection: "缺少选择",
  extra_selection: "多余选择",
  selection_mismatch: "配料不匹配",
};

function renderConfirmErrors(detail) {
  const errors = (detail && detail.errors) || [];
  return `<div class="alert cycle">
      <strong>⚠ ${esc(detail && detail.message ? detail.message : "方案校验未通过")}</strong>
      <ul class="confirm-errors">
        ${errors.map((er) => {
          const label = CONFIRM_ERROR_LABEL[er.type] || er.type;
          const target = er.selected_code ? ` → <span class="code-mono">${esc(er.selected_code)}</span>` : "";
          const extra = er.trigger_allergens && er.trigger_allergens.length
            ? `（${esc(er.trigger_allergens.join("、"))}）` : "";
          let blockedHtml = "";
          if (er.blocked) {
            blockedHtml = `<div class="blocked-reason">${esc(er.blocked.reason_text)}</div>`;
          }
          return `<li>
            <span class="badge ${er.type === "forbidden" ? "cycle" : "missing"}">${esc(label)}</span>
            <span class="code-mono">${esc(er.ingredient_code)}</span>${target}${esc(extra)}
            <div>${esc(er.message)}</div>
            ${blockedHtml}
          </li>`;
        }).join("")}
      </ul>
      <p class="hint" style="margin:8px 0 0;color:var(--danger)">请重新生成方案并选择后再确认（原料、替代关系或过敏原可能在方案生成后发生了变化）。</p>
    </div>`;
}

function renderConfirmed(data) {
  const sl = data.shopping_list;
  let html = `
    <div class="card confirmed-card">
      <div class="panel-head">
        <h3>🛒 ${esc(sl.title)}</h3>
        <div class="head-controls">
          <button class="btn primary" data-act="download-json">⬇ 下载 JSON</button>
          <button class="btn primary" data-act="download-csv">⬇ 下载 CSV</button>
        </div>
      </div>
      <div class="summary-bar">
        <div class="summary-box"><h4>校验时间</h4><small>${esc(data.validated_at)}</small></div>
        <div class="summary-box"><h4>避开的过敏原</h4>${
          data.avoid_allergens.length ? allergenTags(data.avoid_allergens, "direct")
          : '<span class="tag muted">无</span>'}</div>
        <div class="summary-box"><h4>配料 / 替换项</h4><strong>${data.summary.item_count}</strong> 项配料，替换 <strong>${data.summary.substitution_count}</strong> 项</div>
        <div class="summary-box"><h4>采购行数</h4><strong>${data.summary.purchase_line_count}</strong> 行</div>
        <div class="summary-box"><h4>终点过敏原并集</h4>${allergenTags(data.summary.allergens)}</div>
      </div>
      ${sl.merge_notes.length
        ? `<div class="alert warn"><strong>合并说明：</strong><ul>${
            sl.merge_notes.map((n) => `<li>${esc(n)}</li>`).join("")
          }</ul></div>` : ""}
      <table class="data-table">
        <thead><tr><th>#</th><th>采购原料（终点）</th><th>合并数量</th><th>单位</th><th>过敏原</th><th>合并 / 无法合并说明</th></tr></thead>
        <tbody>
          ${sl.lines.map((ln) => `
            <tr class="${ln.merged ? "row-added" : ""}">
              <td>${ln.seq}</td>
              <td><span class="code-mono">${esc(ln.selected_code)}</span><br><small>${esc(ln.selected_name)}</small></td>
              <td>${ln.quantity == null ? '<span class="tag muted">用量未登记</span>' : esc(ln.quantity)}</td>
              <td>${esc(ln.unit)}</td>
              <td>${allergenTags(ln.allergens)}</td>
              <td><small>${ln.merge_note ? esc(ln.merge_note) : '<span class="tag ok">单一来源</span>'}</small></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>

    <details class="card" open>
      <summary><strong>每个配方配料的替代路径与过敏原（随清单保留）</strong></summary>
      <table class="data-table" style="margin-top:10px">
        <thead><tr><th>配方配料</th><th>所选终点</th><th>替代路径</th><th>用量 / 单位</th><th>过敏原</th></tr></thead>
        <tbody>
          ${data.items.map((it) => `
            <tr class="${it.substituted ? "row-substituted" : ""}">
              <td><span class="code-mono">${esc(it.ingredient_code)}</span><br><small>${esc(it.ingredient_name)}</small></td>
              <td><span class="code-mono">${esc(it.selected_code)}</span><br><small>${esc(it.selected_name)}</small>${it.substituted ? ' <span class="tag new">已替代</span>' : ' <span class="tag ok">原方保留</span>'}</td>
              <td><div class="path-line" style="border:none;background:none;padding:0">${safePathChain(it.path)}</div></td>
              <td>${it.quantity == null ? "用量未登记" : esc(it.quantity)} ${esc(it.unit || "")}</td>
              <td>${allergenTags(it.allergens)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </details>`;
  $("#safe-confirmed").innerHTML = html;
  $("#safe-confirmed").scrollIntoView({ behavior: "smooth" });
}

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildShoppingCsv(data) {
  const rows = [];
  rows.push(["== 采购清单（相同终点原料同单位数量已合并；不同单位分行不换算） =="]);
  rows.push(["序号", "原料代码", "原料名称", "合并数量", "单位", "过敏原", "合并/无法合并说明"]);
  for (const ln of data.shopping_list.lines) {
    rows.push([
      ln.seq, ln.selected_code, ln.selected_name,
      ln.quantity == null ? "用量未登记" : ln.quantity,
      ln.unit, ln.allergens.join("、"), ln.merge_note,
    ]);
  }
  rows.push([]);
  rows.push(["== 每个配方配料的替代路径、过敏原与用量明细 =="]);
  rows.push(["配方配料代码", "配方配料名称", "所选终点代码", "所选终点名称", "替代路径", "替代边数", "用量", "单位", "终点过敏原"]);
  for (const it of data.items) {
    rows.push([
      it.ingredient_code, it.ingredient_name, it.selected_code, it.selected_name,
      it.path_chain, it.path_length,
      it.quantity == null ? "用量未登记" : it.quantity, it.unit,
      it.allergens.join("、"),
    ]);
  }
  // UTF-8 BOM：Excel 直接打开不乱码
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

$("#safe-confirmed").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !safeState.shoppingList) return;
  const data = safeState.shoppingList;
  const base = `purchase-list-${data.recipe.code}-v${data.recipe.version}`;
  if (btn.dataset.act === "download-json") {
    downloadText(`${base}.json`, JSON.stringify(data, null, 2), "application/json");
  } else if (btn.dataset.act === "download-csv") {
    downloadText(`${base}.csv`, buildShoppingCsv(data), "text/csv;charset=utf-8");
  }
});

$("#btn-safe-confirm").addEventListener("click", async () => {
  const id = $("#safe-recipe").value;
  if (!id) return toast("请先选择配方", true);
  if (!safeState.selectedRank || !safeState.plansData) return toast("请先选择一组方案", true);
  const plan = safeState.plansData.plans.find((p) => p.rank === safeState.selectedRank);
  if (!plan) return toast("所选方案已失效，请重新生成方案", true);
  const selections = plan.items.map((it) => ({
    ingredient_code: it.ingredient_code,
    selected_code: it.selected_code,
  }));
  try {
    const data = await api(`/api/recipes/${id}/confirm-plan`, {
      method: "POST",
      body: {
        avoid_allergens: Array.from(safeState.checked),
        selections,
      },
    });
    safeState.shoppingList = data;
    renderConfirmed(data);
    toast("方案校验通过，采购清单已生成");
  } catch (err) {
    safeState.shoppingList = null;
    $("#safe-confirmed").innerHTML =
      renderConfirmErrors(err.payload) +
      '<div class="card"><p class="hint">采购清单未生成。以下为当前所选方案，可核对后重新生成方案。</p></div>';
    $("#safe-confirmed").scrollIntoView({ behavior: "smooth" });
    toast(err.message, true);
  }
});

// ---------------- 版本对比 ----------------

$("#btn-compare").addEventListener("click", async () => {
  const a = $("#cmp-a").value;
  const b = $("#cmp-b").value;
  if (!a || !b) return toast("请选择两个配方版本", true);
  if (a === b) return toast("请选择不同的两个版本", true);
  try {
    const data = await api("/api/compare", {
      method: "POST",
      body: { recipe_a: { id: Number(a) }, recipe_b: { id: Number(b) } },
    });
    renderCompare(data);
  } catch (err) {
    toast(err.message, true);
  }
});

function diffItemRows(items, kind) {
  return items.map((x) => `
    <tr class="row-${kind === "added" ? "added" : "removed"}">
      <td class="code-mono">${esc(x.ingredient_code)}</td>
      <td>${esc(x.ingredient_name)}</td>
      <td>${x.quantity ?? ""}${esc(x.unit || "")}</td>
      <td>${allergenTags(x.direct_allergens, "direct")}</td>
      <td>${allergenTags(x.total_allergens, "allergen")}</td>
    </tr>`).join("");
}

function renderCompare(d) {
  let html = `
    <div class="summary-bar">
      <div class="summary-box"><h4>版本 A</h4><strong>${esc(d.recipe_a.code)}</strong> v${esc(d.recipe_a.version)}<br><small>${esc(d.recipe_a.name)}</small></div>
      <div class="summary-box"><h4>版本 B</h4><strong>${esc(d.recipe_b.code)}</strong> v${esc(d.recipe_b.version)}<br><small>${esc(d.recipe_b.name)}</small></div>
      <div class="summary-box"><h4>直接过敏原：新增 / 移除</h4>
        <div>新增 ${allergenTags(d.direct_allergens.added, "new")}</div>
        <div>移除 ${allergenTags(d.direct_allergens.removed, "ok")}</div>
      </div>
      <div class="summary-box"><h4>含替代链：新增 / 移除</h4>
        <div>新增 ${allergenTags(d.total_allergens.added, "new")}</div>
        <div>移除 ${allergenTags(d.total_allergens.removed, "ok")}</div>
      </div>
    </div>`;

  if (d.cycles.a.length || d.cycles.b.length) {
    html += `<div class="alert cycle">循环：A 版 ${d.cycles.a.length} 条，B 版 ${d.cycles.b.length} 条（可在分析页查看具体路径）</div>`;
  }
  if (d.missing_nodes.length) {
    html += `<div class="alert warn">缺失原料节点：${d.missing_nodes.map(esc).join("、")}</div>`;
  }

  html += `<div class="diff-section"><h3>原料变化</h3>
    <table class="data-table">
      <thead><tr><th>代码</th><th>名称</th><th>用量</th><th>直接过敏原</th><th>替代链过敏原</th></tr></thead>
      <tbody>
        <tr><td colspan="5" class="tag ok" style="border:none">B 版新增</td></tr>
        ${diffItemRows(d.items.added, "added") || '<tr><td colspan="5" class="empty">无</td></tr>'}
        <tr><td colspan="5" class="tag muted" style="border:none">A 版移除（B 版不再使用）</td></tr>
        ${diffItemRows(d.items.removed, "removed") || '<tr><td colspan="5" class="empty">无</td></tr>'}
      </tbody>
    </table></div>`;

  if (d.items.changed.length) {
    html += `<div class="diff-section"><h3>用量变化</h3>
      <table class="data-table"><thead><tr><th>原料</th><th>A 用量</th><th>B 用量</th></tr></thead><tbody>`;
    html += d.items.changed.map((c) => `
      <tr><td class="code-mono">${esc(c.ingredient_code)} · ${esc(c.ingredient_name)}</td>
      <td>${c.from.quantity ?? ""}${esc(c.from.unit || "")}</td>
      <td>${c.to.quantity ?? ""}${esc(c.to.unit || "")}</td></tr>`).join("");
    html += `</tbody></table></div>`;
  }

  $("#compare-result").innerHTML = html;
}

// ---------------- 导入 / 导出 / 示例 ----------------

$("#btn-export").addEventListener("click", async () => {
  const data = await api("/api/export");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `allergen-tracker-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  $("#io-message").textContent = "已导出 " + JSON.stringify({
    ingredients: data.ingredients.length,
    recipes: data.recipes.length,
    substitutions: data.substitutions.length,
  });
});

$("#import-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $("#import-text").value = reader.result; };
  reader.readAsText(file);
});

$("#btn-import").addEventListener("click", async () => {
  const text = $("#import-text").value.trim();
  if (!text) return toast("请先粘贴或选择 JSON 文件", true);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return toast("JSON 解析失败", true);
  }
  const mode = $("#import-mode").value;
  if (mode === "replace" && !confirm("replace 模式将清空现有全部数据，确定继续？")) return;
  try {
    const result = await api(`/api/import?mode=${mode}`, { method: "POST", body: payload });
    $("#io-message").textContent = "导入完成：" + JSON.stringify(result, null, 2);
    toast("导入完成");
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#btn-seed").addEventListener("click", async () => {
  try {
    const counts = await api("/api/seed", { method: "POST" });
    $("#io-message").textContent = "示例数据已载入：" + JSON.stringify(counts, null, 2);
    toast("示例数据已载入");
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------- 启动 ----------------

refreshAll()
  .then(() => loadSafeAllergens())
  .catch((err) => toast("初始化失败: " + err.message, true));
