/**
 * AUTO_RULES.verify / FLOW_SERIES.grasp に書かれた全トークンが
 *   ① chrome-extension/*.js 内で実際に発火していること（動的トークン展開含む）
 *   ② chrome-extension/search-audit.js の KEEP_STEP / RULE_STEP で残ること
 * を機械的に検証し、死んだトークンや page:/dl: 抜けの再発を防ぐ仕組み。
 * 実行: npx tsx app/lib/__tests__/auto-rules-verify-exists.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTO_RULES, verifyKeysOf, type AutoRule } from "../auto-procedure-rules";
import { PLAYBOOK_FLOW_SERIES, ITANDI_FLOW_SERIES } from "../action-playbook";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail === undefined ? "" : "\n      " + JSON.stringify(detail))); }
}

const EXT_DIR = path.join(process.cwd(), "chrome-extension");
const jsFiles = fs.readdirSync(EXT_DIR).filter((f) => f.endsWith(".js"));
const extBodies = new Map<string, string>();
for (const f of jsFiles) {
  extBodies.set(f, fs.readFileSync(path.join(EXT_DIR, f), "utf8"));
}
const allExt = [...extBodies.values()].join("\n");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SA = require(path.join(EXT_DIR, "search-audit.js"));

/**
 * 動的組み立てトークン・標準段・k:d 形式の実在判定:
 *   - page:guide_phase_one はリテラル直接発火（先に確認）
 *   - page:guide_phase_<ph> → page-script.js の _auditStepP("guide_phase_" + ph) + phase 定数
 *   - page:flow_done_<ph> / page:flow_gap_<ph> → page-script.js の ("flow_done_" + ph) + _FLOW_PHASES
 *   - page:confirm_press_ok → page-script.js の String(domain || "other") + "_press_ok"
 *   - page:ward_clear_one_done / page:clear_one_done → page-script.js の tag + "_done"
 *   - dl:flow_atom_(ok|gap)_<atom> → bulk-dl.js の "flow_atom_" + (ok ? "ok_" : "gap_") + atom
 *   - begin / fill_done / finish / result / fill_progress → search-audit.js の標準段
 *   - k:d のように詳細文字列まで含む場合は k 部分で実在確認
 */
function tokenEmittedInExt(token: string): boolean {
  const bare = token.replace(/^(page:|dl:)/, "");
  // 1. 直接リテラル一致（"guide_phase_one" 等はこちらで先に通る）
  const nonAuditFiles = jsFiles.filter((f) => f !== "search-audit.js");
  for (const f of nonAuditFiles) {
    const body = extBodies.get(f) || "";
    if (body.includes(`"${bare}"`) || body.includes(`'${bare}'`) || body.includes(`"dl:${bare}"`)) return true;
  }

  // 2. page:guide_phase_<ph> 動的生成
  const gp = token.match(/^page:guide_phase_([a-z0-9_]+)$/);
  if (gp) {
    const ps = extBodies.get("page-script.js") || "";
    return ps.includes('"guide_phase_" +') && ps.includes(`"${gp[1]}"`);
  }

  // 3. page:flow_done_<ph> / page:flow_gap_<ph> 動的生成
  const fd = token.match(/^page:flow_(?:done|gap)_([a-z0-9_]+)$/);
  if (fd) {
    const ps = extBodies.get("page-script.js") || "";
    return ps.includes('"flow_done_" + ph') && ps.includes(`"${fd[1]}"`);
  }

  // 4. page:<domain>_press_ok 動的生成（例: confirm_press_ok）
  const po = token.match(/^page:([a-z0-9_]+)_press_ok$/);
  if (po) {
    const ps = extBodies.get("page-script.js") || "";
    return ps.includes('+ "_press_ok"') && (ps.includes(`"${po[1]}"`) || ps.includes(`${po[1]}_press_ok`));
  }

  // 5. page:(ward_clear_one|clear_one)_done 動的生成
  const cd = token.match(/^page:(ward_clear_one|clear_one)_done$/);
  if (cd) {
    const ps = extBodies.get("page-script.js") || "";
    return (ps.includes('+ "_done"') || ps.includes('"_done"')) && ps.includes(`"${cd[1]}"`);
  }

  // 6. dl:flow_atom_(ok|gap)_<atom> 動的生成
  const fa = token.match(/^dl:flow_atom_(?:ok|gap)_([a-z0-9_]+)$/);
  if (fa) {
    const bd = extBodies.get("bulk-dl.js") || "";
    return bd.includes('"flow_atom_" +') && bd.includes(`"${fa[1]}"`);
  }

  // 7. search-audit.js の標準段（begin / fill_done / finish / result / fill_progress）
  if (["begin", "fill_done", "finish", "result", "fill_progress"].includes(bare)) {
    const sa = extBodies.get("search-audit.js") || "";
    return sa.includes(`"${bare}"`);
  }

  // 8. 複合キー（例: dl:search_grasp_gate:armed_rows → ベース dl:search_grasp_gate）
  if (/^(page:|dl:)[^:]+:[^:]+$/.test(token)) {
    const base = token.replace(/:[^:]+$/, "");
    return tokenEmittedInExt(base);
  }
  return false;
}

function requiredKeysOfRule(r: AutoRule): string[] {
  const v = r.verify;
  if (!v) return [];
  const out: string[] = [];
  if (v.onlyIf) out.push(...v.onlyIf);
  if (v.mustHave) out.push(v.mustHave);
  if (v.mustHaveAny) out.push(...v.mustHaveAny);
  // mustNot には「廃止済みで出てはならない旧印」を入れるため発火確認からは除外する
  return [...new Set(out)];
}

console.log("■ 1. AUTO_RULES 全 verify (onlyIf/mustHave/mustHaveAny) トークンが拡張コードに実在するか");
{
  const dead: Array<{ rule: string; token: string }> = [];
  for (const r of AUTO_RULES) {
    for (const tok of requiredKeysOfRule(r)) {
      if (!tokenEmittedInExt(tok)) dead.push({ rule: r.id, token: tok });
    }
  }
  ok(`AUTO_RULES 全 ${AUTO_RULES.length}件の必須 verify トークンに死んだ印が0件`, dead.length === 0, dead);
}

console.log("■ 2. AUTO_RULES 全 verify トークンが search-audit.js の KEEP_STEP / RULE_STEP で落ちないか");
{
  const missingKeep: Array<{ rule: string; token: string }> = [];
  for (const r of AUTO_RULES) {
    for (const tok of verifyKeysOf(r.verify)) {
      if (!SA.KEEP_STEP.test(tok) && !SA.RULE_STEP.test(tok)) {
        missingKeep.push({ rule: r.id, token: tok });
      }
    }
  }
  ok("全 verify トークンが KEEP_STEP または RULE_STEP に一致する", missingKeep.length === 0, missingKeep);
}

console.log("■ 3. PLAYBOOK_FLOW_SERIES / ITANDI_FLOW_SERIES 全段の grasp トークン実在検証");
{
  const bg = extBodies.get("background.js") || "";
  const sa = extBodies.get("search-audit.js") || "";
  const isBgOrAuditToken = (tok: string) => !/^(page:|dl:)/.test(tok) && (bg.includes(`"${tok}"`) || sa.includes(`"${tok}"`));

  for (const [label, series] of [
    ["PLAYBOOK_FLOW_SERIES", PLAYBOOK_FLOW_SERIES],
    ["ITANDI_FLOW_SERIES", ITANDI_FLOW_SERIES],
  ] as const) {
    const emptyPhases = series.filter((p) => !p.grasp.length).map((p) => p.id);
    ok(`${label}: grasp が空の段が0件`, emptyPhases.length === 0, emptyPhases);

    const badPrefix: Array<{ phase: string; token: string }> = [];
    const dead: Array<{ phase: string; token: string }> = [];
    for (const ph of series) {
      for (const tok of ph.grasp) {
        if (!/^(page:|dl:)/.test(tok) && !isBgOrAuditToken(tok)) badPrefix.push({ phase: ph.id, token: tok });
        if (!tokenEmittedInExt(tok)) dead.push({ phase: ph.id, token: tok });
      }
    }
    ok(`${label}: 全 grasp の接頭辞（page:/dl:/background直記）が正しい`, badPrefix.length === 0, badPrefix);
    ok(`${label}: 全 grasp トークンが拡張コードに実在する`, dead.length === 0, dead);
  }
}

// 念のため allExt も利用（lint 回避）
if (!allExt.length) throw new Error("empty ext");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
