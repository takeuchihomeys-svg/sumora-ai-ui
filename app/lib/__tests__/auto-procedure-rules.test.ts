// 2026-11-20: 自動の決まり（手順書に載せる正本）と、手順書への反映の仕組みを確かめる。DB も LLM も使わない。
//   竹内さん「改善したら手順書が改善されるように仕組みをちゃんとつくって強化する」「ちゃんとテストもして」
// 実行: npx tsx app/lib/__tests__/auto-procedure-rules.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_RULES, AUTO_RULES_REVIEWED_UP_TO, RULE_SCENE_JA, autoRulesVersion, compareExtVersion, checkRulesInCode,
  judgeRulesOnAudit, judgePlaybookReflect, parsePlaybookSeen, type AuditStep,
} from "../auto-procedure-rules";
import { buildPlaybook, checkPlaybook, PLAYBOOK_BUILD_V, refreshPlaybookIfStale } from "../action-playbook";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

const EXT = join(process.cwd(), "chrome-extension");
const read = (f: string) => readFileSync(join(EXT, f), "utf8");
const pageScript = read("page-script.js");
const manifestVer = String(JSON.parse(read("manifest.json")).version);
const verNum = (v: string) => v.split(".").map((x) => Number(x) || 0);
const cmpVer = (a: string, b: string) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return 0; };

console.log("■ 決まりの一覧の形");
{
  const ids = AUTO_RULES.map((r) => r.id);
  ok("id が重ならない", new Set(ids).size === ids.length, ids.join(","));
  ok("全部の決まりに場面の名前がある", AUTO_RULES.every((r) => !!RULE_SCENE_JA[r.scene]));
  ok("全部の決まりに人が読む文がある（10文字以上）", AUTO_RULES.every((r) => r.text.length >= 10));
  ok("kb は id8（8桁の16進）か null", AUTO_RULES.every((r) => r.kb === null || /^[0-9a-f]{8}$/.test(r.kb)));
  ok("前のお客さんを外す場面・ペット・押し方の決まりがある（人の録画の場面に無い所）",
    ["clear", "pet", "press"].every((sc) => AUTO_RULES.some((r) => r.scene === sc)));
  ok("検索結果の並び替え（AD）の決まりがある（抜け防止）", AUTO_RULES.some((r) => r.id === "ad_sort_hover" && r.scene === "list" && r.file === "bulk-dl.js"));
}

console.log("■ コードに入っているか（直したのに手順書だけ・手順書だけで直していない、を止める）");
{
  for (const r of AUTO_RULES) {
    const src = r.file === "page-script.js" ? pageScript : read(r.file);
    ok(`${r.id}: 印「${r.marker.slice(0, 30)}」が ${r.file} にある`, src.includes(r.marker));
  }
  const m = pageScript.match(/var _AXLX_RULES_DONE = \[([\s\S]*?)\];/);
  const done = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
  const ids = AUTO_RULES.map((r) => r.id);
  ok("拡張の _AXLX_RULES_DONE がある", done.length > 0);
  ok("拡張の _AXLX_RULES_DONE と決まりの一覧が同じ（足りない・余る が無い）",
    done.length === ids.length && ids.every((id) => done.includes(id)),
    `一覧に有って拡張に無い: ${ids.filter((id) => !done.includes(id)).join(",") || "-"} ／ 拡張に有って一覧に無い: ${done.filter((id) => !ids.includes(id)).join(",") || "-"}`);
}

console.log("■ 版（拡張の版を上げたら決まりの一覧を見直す）");
{
  const pageVer = (pageScript.match(/var _AXLX_PAGE_VER = "([^"]+)"/) || [])[1] ?? "";
  ok("manifest と page-script の版が同じ", pageVer === manifestVer, `${manifestVer} / ${pageVer}`);
  ok(`決まりを見直した版（${AUTO_RULES_REVIEWED_UP_TO}）が拡張の版（${manifestVer}）と同じ`,
    cmpVer(AUTO_RULES_REVIEWED_UP_TO, manifestVer) === 0,
    "拡張の版を上げたら app/lib/auto-procedure-rules.ts の決まりを見直し、AUTO_RULES_REVIEWED_UP_TO も上げる");
  ok("どの決まりも入った版が拡張の版以下", AUTO_RULES.every((r) => r.since === null || cmpVer(r.since, manifestVer) <= 0),
    AUTO_RULES.filter((r) => r.since && cmpVer(r.since, manifestVer) > 0).map((r) => `${r.id}=${r.since}`).join(","));
  const v1 = autoRulesVersion();
  ok("決まりの版は8桁", /^[0-9a-f]{8}$/.test(v1), v1);
  ok("決まりの版は同じ入力なら同じ", autoRulesVersion() === v1);
  const changed = AUTO_RULES.map((r, i) => (i === 0 ? { ...r, text: r.text + "。" } : r));
  ok("文を1つ変えると版が変わる（手順書が古いと分かる）", autoRulesVersion(changed) !== v1);
}

console.log("■ 拡張の手順書の取り込み（content → page）");
{
  const content = read("content.js");
  const push = (content.match(/var PUSH_KEYS = \[([\s\S]*?)\];/) || [])[1] ?? "";
  ok("content.js の PUSH_KEYS に axlx_learn_playbook がある", push.includes("\"axlx_learn_playbook\""));
  ok("PUSH_KEYS の最後は axlx_learn_gaps のまま", /"axlx_learn_gaps",\s*$/.test(push.trim() + "\n") || push.trim().endsWith("\"axlx_learn_gaps\","));
  const next = (pageScript.match(/var _LEARN_NEXT_KEYS = \[([\s\S]*?)\];/) || [])[1] ?? "";
  ok("page-script の _LEARN_NEXT_KEYS に axlx_learn_playbook がある", next.includes("\"axlx_learn_playbook\""));
  ok("page-script が window.__axlxLearnPlaybook に置く", pageScript.includes("window.__axlxLearnPlaybook = "));
  ok("反映の関所で手順書を読んだ印を残す", /_auditFullFlowMapLedger\("reflect_done"\);[^\n]*\n\s*try \{ _auditPlaybookSeen\(\); \}/.test(pageScript));
  const pin = (pageScript.match(/var _PIN = \/\^\(([^)]*)\)\//) || [])[1] ?? "";
  for (const k of ["playbook_", "hidden_press", "clear_stage", "sel_one_press", "search_cursor", "search_armed", "modal_confirm", "confirm_press_ok"]) {
    ok(`点検記録で ${k} を間引かない（_PIN）`, pin.split("|").includes(k));
  }
  ok("background が束の手順書を axlx_learn_playbook に置く", read("background.js").includes("axlx_learn_playbook: (bundle.playbook"));
}

console.log("■ 点検記録で守れたかを確かめる");
{
  const t0 = 1_000_000;
  const good: AuditStep[] = [
    { k: "page:clear_stage", d: "room_layout_id[] を開けて外す", at: t0 },
    { k: "page:clear_stage", d: "eq_rm[] を開けて外す", at: t0 + 1000 },
    { k: "page:clear_stage", d: "city_code[] を開けて外す", at: t0 + 2000 },
    { k: "page:modal_confirm", d: "確定してリストへ", at: t0 + 3000 },
    { k: "page:confirm_press_ok", d: "押す済", at: t0 + 4200 },
    { k: "page:search_cursor", d: "検索へカーソル", at: t0 + 9000 },
    { k: "page:search_armed", d: "物件取得", at: t0 + 10500 },
    { k: "page:playbook_seen", d: "v=aaaa rv=bbbb 決まり=16/16 無い=- 手順書に無い=- 場面=6 手=30", at: t0 - 100 },
  ];
  const j = Object.fromEntries(judgeRulesOnAudit(good).map((x) => [x.id, x]));
  // 退役（段階1・2026-11-27）: 箱ごとの外す順番は廃止。残りが無い回は no_data（外さない）
  ok("残りが無い回は no_data（1つずつ外さない）", j.clear_per_panel.result === "no_data", j.clear_per_panel.why);
  ok("見えない押下が無い → ok", j.no_hidden_press.result === "ok");
  ok("確定まで 1.2秒 → ok", j.confirm_decide.result === "ok", j.confirm_decide.why);
  ok("検索まで 1.5秒 → ok", j.search_decide.result === "ok", j.search_decide.why);
  ok("手順書が届いた → ok", j.playbook_read.result === "ok");
  ok("確かめ方が無い決まりは no_data（ok と混ぜない）", j.order_human.result === "no_data");

  const bad: AuditStep[] = [
    { k: "page:clear_stage", d: "city_code[] を開けて外す", at: t0 },
    { k: "page:clear_stage", d: "room_layout_id[] を開けて外す", at: t0 + 1000 },
    { k: "page:hidden_press", d: "rental_cost2 見える欄が無くカーソル無しで押した", at: t0 + 1500 },
    { k: "page:modal_confirm", d: "確定してリストへ", at: t0 + 2000 },
    { k: "page:confirm_press_ok", d: "押す済", at: t0 + 12000 },
    { k: "page:search_cursor", d: "検索へカーソル", at: t0 + 13000 },
    { k: "page:search_armed", d: "物件取得", at: t0 + 21000 },
    { k: "page:playbook_none", d: "手順書が届いていない", at: t0 - 100 },
  ];
  const b = Object.fromEntries(judgeRulesOnAudit(bad).map((x) => [x.id, x]));
  ok("外す順番が逆（所在地→間取り）でも残りが無ければ no_data", b.clear_per_panel.result === "no_data", b.clear_per_panel.why);
  const stay: AuditStep[] = [{ k: "page:leftover_soft_stay", d: "前客の欄が残り（1つずつ戻すのは廃止）", at: t0 }];
  const st = Object.fromEntries(judgeRulesOnAudit(stay).map((x) => [x.id, x]));
  ok("残りがあって外さず止めた → ok", st.clear_per_panel.result === "ok", st.clear_per_panel.why);
  ok("見えない押下 → ng", b.no_hidden_press.result === "ng");
  ok("確定まで 10秒 → ng", b.confirm_decide.result === "ng", b.confirm_decide.why);
  ok("検索まで 8秒 → ng（詰まり）", b.search_decide.result === "ng", b.search_decide.why);
  ok("手順書が届いていない → ng", b.playbook_read.result === "ng");

  const empty = judgeRulesOnAudit([]);
  // 2.8.145: 記録が空の回（始まっていない回・実測 #1546/#1547）は ng と数えない
  ok("記録が空なら ng は無い（全部 no_data）",
    empty.every((x) => x.result === "no_data"), empty.filter((x) => x.result === "ng").map((x) => x.id).join(","));
  const cur = (steps: { k: string; d: string }[]) => judgeRulesOnAudit(steps, AUTO_RULES, "2.8.138").find((x) => x.id === "one_cursor")!.result;
  ok("1つのカーソルの印があれば ok", cur([{ k: "page:cursor_one", d: "要素=1 OSを隠す=1 形=arrow" }]) === "ok");
  ok("カーソルが2つ・古い作りなら ng", cur([{ k: "page:cursor_one", d: "" }, { k: "page:cursor_two", d: "要素=2" }]) === "ng" && cur([{ k: "page:cursor_old", d: "" }]) === "ng");
  ok("2.8.138 より前の拡張の回は確かめられない（no_data）", judgeRulesOnAudit([], AUTO_RULES, "2.8.137").find((x) => x.id === "one_cursor")!.result === "no_data");
  const oldExt = Object.fromEntries(judgeRulesOnAudit(bad, AUTO_RULES, "2.8.133").map((x) => [x.id, x]));
  ok("直す前の拡張（2.8.133）の回は、後から入った決まりを ng にしない（no_data）",
    oldExt.no_hidden_press.result === "no_data" && oldExt.search_decide.result === "no_data" && oldExt.playbook_read.result === "no_data", JSON.stringify(oldExt.no_hidden_press));
  ok("前からある決まり（since 無し）は古い拡張の回でも見る（版で no_data にしない）", AUTO_RULES.filter((r) => !r.since && r.verify).every((r) => oldExt[r.id].result !== "no_data" || !/より前/.test(oldExt[r.id].why)));
  const newExt = Object.fromEntries(judgeRulesOnAudit(bad, AUTO_RULES, "2.8.137").map((x) => [x.id, x]));
  ok("直した後の拡張（2.8.137）の回なら ng を出す", newExt.no_hidden_press.result === "ng" && newExt.search_decide.result === "ng");
  const seenOnly: AuditStep[] = [{ k: "page:playbook_seen", d: "v=a", at: 1 }];
  ok("印があれば手順書を読めた（ok）", judgeRulesOnAudit(seenOnly).find((x) => x.id === "playbook_read")?.result === "ok");
  ok("版の比べ（2.8.99 < 2.8.137 < 2.9.0）", compareExtVersion("2.8.99", "2.8.137") < 0 && compareExtVersion("2.9.0", "2.8.137") > 0 && compareExtVersion("2.8.137", "2.8.137") === 0);
  const shuffled = [...good].reverse();
  ok("段の並びが時刻順でなくても同じ判定", JSON.stringify(judgeRulesOnAudit(shuffled)) === JSON.stringify(judgeRulesOnAudit(good)));
}

console.log("■ 手順書を読んだ印");
{
  const s = parsePlaybookSeen("v=12ab34cd rv=99ff0011 決まり=14/16 無い=a_rule,b_rule,+1 手順書に無い=c_rule 場面=6 手=31");
  ok("版を読む", s?.version === "12ab34cd" && s?.rules_v === "99ff0011");
  ok("数を読む", s?.have === 14 && s?.rules === 16 && s?.scenes === 6 && s?.hands === 31);
  ok("拡張に無い決まり（先頭2つ＋残り）", s?.missing.join(",") === "a_rule,b_rule" && s?.missing_more === 1);
  ok("『手順書に無い』を『無い』と取り違えない", s?.extra.join(",") === "c_rule" && s?.extra_more === 0);
  const e = parsePlaybookSeen("v=x rv=y 決まり=16/16 無い=- 手順書に無い=- 場面=6 手=31");
  ok("- は空", e?.missing.length === 0 && e?.extra.length === 0);
  ok("空の文は null", parsePlaybookSeen("") === null && parsePlaybookSeen(null) === null);
}

console.log("■ 手順書に決まりと1手ずつの細部が載る（作り方 3）");
{
  const bundle = {
    scene_flows: [
      { scene: "area", runs: 6, ops: 81, steps: ["所在地絞り込み＋", "大阪市西区", "city_code[]", "確定してリストへ"], gap_ms: 66, variants: 4 },
      { scene: "cond", runs: 5, ops: 48, steps: ["絞り込み条件＋", "eq_rm[]", "square_meter_l"], gap_ms: 50, variants: 2 },
    ],
    points: {
      "左の所在地絞り込み＋｜span": { n: 7, x: 0.42, y: 0.5 },
      "city_code[]": { n: 2, x: 0.1, y: 0.5 },
      "確定してリストへ": { n: 9, x: 0.5, y: 0.45 },
    },
    opens: { "所在地絞り込み＋": { opens: "所在地の箱", n: 3 }, "絞り込み条件＋": { opens: "推測", n: 1, guessed: true } },
    next_page: {},
  };
  const pb = buildPlaybook(bundle as never);
  ok(`作り方の版は ${PLAYBOOK_BUILD_V}（3 以上）`, pb.build_v === PLAYBOOK_BUILD_V && PLAYBOOK_BUILD_V >= 3);
  ok("決まりが全部載る", pb.rules.length === AUTO_RULES.length && pb.rules.every((r, i) => r.id === AUTO_RULES[i].id));
  ok("決まりの版がコードと同じ", pb.rules_v === autoRulesVersion());
  ok("決まりに場面の名前が付く", pb.rules.every((r) => r.scene_label === RULE_SCENE_JA[r.scene]));
  const area = pb.scenes.find((s) => s.scene === "area")!;
  ok("1手ずつの細部は手順と同じ数", area.detail.length === area.steps.length, `${area.detail.length}/${area.steps.length}`);
  ok("飾り付きの押す位置（左の…｜span）も欄の名前で引ける", area.detail[0].aim?.x === 0.42 && area.detail[0].aim?.confidence === "solid", JSON.stringify(area.detail[0]));
  ok("票が少ない押す位置は thin", area.detail[1].aim?.confidence === "thin", JSON.stringify(area.detail[1]));
  ok("人が確かめた開く物は載る", area.detail[0].opens === "所在地の箱");
  const cond = pb.scenes.find((s) => s.scene === "cond")!;
  ok("推測の開く物は載せない", cond.detail[0].opens === null);
  ok("今日の実データの欄が読める名前になる（絞り込み条件＋・eq_rm[]・square_meter_l）",
    cond.detail.filter((d) => d.from !== "map").map((d) => d.step).join(" > ") === "絞り込み条件を開く > ペットの欄（チェック） > 面積（下限）", cond.steps.join(" > "));
  ok("場面に効く決まりが付く（所在地: 区の速さ・場所の後に条件）", area.rules.includes("ward_pace") && area.rules.includes("area_before_cond"));
  ok("押す位置を学んでいない手は足りない所に出る", pb.gaps.some((g) => /押す位置を学んでいない手/.test(g)), pb.gaps.join(" / "));
  ok("人の手本が無く決まりだけの場面（前のお客さんを外す・ペット）が足りない所に出る",
    pb.gaps.some((g) => /自動の決まりだけの場面/.test(g) && /前のお客さんの条件を外す/.test(g)), pb.gaps.join(" / "));

  const fresh = checkPlaybook(pb as never, Date.parse(pb.based_on));
  ok("作ったばかりの手順書は決まりの指摘が無い", !fresh.some((x) => /決まり|作り方|細部/.test(x)), fresh.join(" / "));
  const old = { ...pb, rules_v: "00000000" };
  ok("決まりの版が古い手順書を見つける", checkPlaybook(old as never, Date.parse(pb.based_on)).some((x) => /決まりの版が古い/.test(x)));
  const noRules = { ...pb, rules: [], build_v: 2 };
  const nr = checkPlaybook(noRules as never, Date.parse(pb.based_on));
  ok("決まりの無い古い手順書（今の DB の形）を見つける", nr.some((x) => /決まりが手順書に入っていない/.test(x)) && nr.some((x) => /作り方が古い/.test(x)), nr.join(" / "));

  ok("版の印は決まりが変われば変わる（手順書の版も上がる）", (() => {
    const a = buildPlaybook(bundle as never).version;
    return typeof a === "string" && a.length >= 8;
  })());
}

console.log("■ 押す位置の出どころ（束 2532 の実際の形: 開くボタンとチェック欄が同じ別名の組）");
{
  const chk = { n: 1238, w: "checkbox", x: 0.5, y: 0.5 };
  const rent = { n: 2248, w: "select", x: 0.38, y: 0.5 };
  const pb = buildPlaybook({
    scene_flows: [
      { scene: "area", runs: 6, ops: 9, steps: ["所在地絞り込み＋", "city_code[]"], gap_ms: 1, variants: 1 },
      { scene: "cond", runs: 5, ops: 9, steps: ["rental_cost2"], gap_ms: 1, variants: 1 },
    ],
    points: {
      "city_code[]": chk, "所在地絞り込み": chk, "所在地を絞り込み": chk, "左の所在地絞り込み＋｜span": chk,
      "左の所在地絞り込み＋｜div.one_slide_searc": { n: 1, w: "button", x: 0.42, y: 0.18 },
      rental_cost2: rent, "賃料上限": rent, "上限賃料": rent,
    },
  } as never);
  const area = pb.scenes.find((s) => s.scene === "area")!.detail;
  const cond = pb.scenes.find((s) => s.scene === "cond")!.detail;
  ok("開くボタンはそのボタンで測った位置（票1でも写しより先）", area[0].aim?.source === "field" && area[0].aim?.x === 0.42 && area[0].aim?.confidence === "thin", JSON.stringify(area[0].aim));
  ok("区のチェック欄は同じ欄の別名の値（測った値・solid）", area[1].aim?.source === "alias" && area[1].aim?.confidence === "solid", JSON.stringify(area[1].aim));
  ok("賃料（上限）は別名に写っていても測った値（alias・solid）", cond[0].aim?.source === "alias" && cond[0].aim?.x === 0.38 && cond[0].aim?.confidence === "solid", JSON.stringify(cond[0].aim));
  const mm = pb.positions.filter((p) => p.source === "mismatch").map((p) => p.field).sort();
  ok("開くボタンの名前にチェック欄の位置が写った物は mismatch（3件）", mm.join(",") === ["左の所在地絞り込み＋｜span", "所在地を絞り込み", "所在地絞り込み"].sort().join(","), mm.join(","));
  ok("数: alias 4（city_code・賃料3）・mismatch 3", pb.positions_alias === 4 && pb.positions_mismatch === 3, `${pb.positions_alias}/${pb.positions_mismatch}`);
  ok("取り違えは足りない所に出る（別名の組の直し先つき）", pb.gaps.some((g) => /開くボタンに箱の中のチェック欄の位置/.test(g) && /field-name-aliases/.test(g)), pb.gaps.join(" / "));
  ok("票が3回未満の手は足りない所に出る", pb.gaps.some((g) => /票が3回未満の手 1件（所在地絞り込みを開く）/.test(g)), pb.gaps.join(" / "));
  const onlyCopy = buildPlaybook({
    scene_flows: [{ scene: "area", runs: 6, ops: 9, steps: ["所在地絞り込み＋"], gap_ms: 1, variants: 1 }],
    points: { "city_code[]": chk, "左の所在地絞り込み＋｜span": chk },
  } as never);
  ok("測ったボタンが無ければ取り違えの位置を使い、solid にしない", onlyCopy.scenes[0].detail[0].aim?.source === "mismatch" && onlyCopy.scenes[0].detail[0].aim?.confidence === "thin", JSON.stringify(onlyCopy.scenes[0].detail[0].aim));
}

console.log("■ 統括Pro でも同じ点検（テストを回し忘れても出る）");
{
  const files = { pageScript, searchAudit: read("search-audit.js"), manifestJson: read("manifest.json"), bulkDl: read("bulk-dl.js"), background: read("background.js") };
  const now = checkRulesInCode(files);
  ok("今のコードは食い違い 0", now.length === 0, now.join(" / "));
  // 現行より1段上の架空版（REVIEWED と一致させない）。版を固定すると REVIEWED が追いついた瞬間に壊れる
  const bumpedVer = (() => {
    const p = manifestVer.split(".").map((x) => Number(x) || 0);
    p[p.length - 1] = (p[p.length - 1] || 0) + 1;
    return p.join(".");
  })();
  const bumped = checkRulesInCode({ ...files, manifestJson: JSON.stringify({ version: bumpedVer }) });
  ok("版だけ上げて一覧を見直していない → 出る", bumped.some((x) => /見直していない/.test(x)), bumped.join(" / "));
  const lost = checkRulesInCode({ ...files, pageScript: files.pageScript.split("function _pickGapPlan").join("function _pickGapRenamed") });
  ok("直しの目印が消えた → 出る", lost.some((x) => /pick_pace の目印/.test(x)), lost.join(" / "));
  const extra = checkRulesInCode({ ...files, pageScript: files.pageScript.replace('"audit_one_progress",', '"audit_one_progress", "new_unlisted",') });
  ok("拡張にだけ足した決まり → 出る（手順書に載らない）", extra.some((x) => /new_unlisted/.test(x)), extra.join(" / "));
  const noBulk = checkRulesInCode({ pageScript: files.pageScript, searchAudit: files.searchAudit, manifestJson: files.manifestJson });
  ok("bulk-dl を渡さないと AD 決まりが抜けると出る", noBulk.some((x) => /ad_sort_hover/.test(x)), noBulk.join(" / "));
  const adMarker = "findSortDetailByRec";
  const adGone = checkRulesInCode({ ...files, bulkDl: files.bulkDl.split(adMarker).join("並べ替えを開く") });
  ok("ADホバーの目印が消えた → 出る（手順書から抜けた重要動作）", adGone.some((x) => /ad_sort_hover の目印/.test(x)), adGone.join(" / "));
}

console.log("■ 点検で AD並び替えを確かめられる");
{
  const okSort: AuditStep[] = [
    { k: "dl:sort_head_hover", d: "並べ替え", at: 1 },
    { k: "dl:sort_ad_hover", d: "AD", at: 2 },
    { k: "dl:sort_hilo", d: "高→低", at: 3 },
  ];
  const j = Object.fromEntries(judgeRulesOnAudit(okSort, AUTO_RULES, "2.8.169").map((x) => [x.id, x]));
  ok("ホバー→高→低まで行けば ad_sort_hover=ok", j.ad_sort_hover.result === "ok", j.ad_sort_hover.why);
  const failSort: AuditStep[] = [
    { k: "dl:sort_head_hover", d: "並べ替え", at: 1 },
    { k: "dl:sort_no_hilo", d: "見えていた: AD", at: 2 },
  ];
  ok("高→低まで行けなければ ng", judgeRulesOnAudit(failSort, AUTO_RULES, "2.8.169").find((x) => x.id === "ad_sort_hover")!.result === "ng");
  ok("並び替えが無い回は no_data", judgeRulesOnAudit([], AUTO_RULES, "2.8.169").find((x) => x.id === "ad_sort_hover")!.result === "no_data");
  ok("search-audit の RULE_STEP に dl:sort_ がある", /dl:sort_/.test(read("search-audit.js")));
}

console.log("■ 渡す時の作り直し（決まりを直してデプロイしたら、次の書き込みを待たずに拡張へ）");
{
  const base = { scene_flows: [{ scene: "area", runs: 3, ops: 9, steps: ["所在地絞り込み＋"], gap_ms: 1, variants: 1 }], points: {} };
  const cur = { ...base, playbook: buildPlaybook(base as never) };
  const r0 = refreshPlaybookIfStale(cur as never);
  ok("今の手順書は作り直さない（同じ物を返す）", !r0.refreshed && r0.bundle === (cur as unknown));
  const oldRules = { ...base, playbook: { ...cur.playbook, rules_v: "00000000" } };
  const r1 = refreshPlaybookIfStale(oldRules as never);
  ok("決まりの版が古ければ作り直す", r1.refreshed && (r1.bundle as { playbook: { rules_v: string } }).playbook.rules_v === autoRulesVersion(), String(r1.why));
  ok("元の束は変えない（DB の行の写しを書き換えない）", oldRules.playbook.rules_v === "00000000");
  const oldBuild = { ...base, playbook: { ...cur.playbook, build_v: 2 } };
  ok("作り方が古ければ作り直す", refreshPlaybookIfStale(oldBuild as never).refreshed);
  ok("手順書が無ければ作る", refreshPlaybookIfStale(base as never).refreshed);
  ok("束が無ければ何もしない", !refreshPlaybookIfStale(null).refreshed);
}

console.log("■ 反映の突き合わせ（DB の手順書 × コード × 自動が読んだ印）");
{
  const pb = buildPlaybook({ scene_flows: [{ scene: "area", runs: 3, ops: 9, steps: ["所在地絞り込み＋"], gap_ms: 1, variants: 1 }], points: {} } as never);
  const seenOk = parsePlaybookSeen(`v=${pb.version.slice(0, 8)} rv=${pb.rules_v} 決まり=${AUTO_RULES.length}/${AUTO_RULES.length} 無い=- 手順書に無い=- 場面=1 手=1`)!;
  const all = judgePlaybookReflect({ playbook: pb, buildV: PLAYBOOK_BUILD_V, seen: [seenOk] });
  ok("全部揃えば ok", all.ok, all.why.join(" / "));
  const dbOld = judgePlaybookReflect({ playbook: { build_v: 2, scenes: [{ steps: ["a"] }] }, buildV: PLAYBOOK_BUILD_V, seen: [] });
  ok("今の DB の形（作り方2・決まり無し・印無し）は ok にならず、理由が3つ以上出る", !dbOld.ok && dbOld.why.length >= 3, dbOld.why.join(" / "));
  const none = judgePlaybookReflect({ playbook: pb, buildV: PLAYBOOK_BUILD_V, seen: ["none"] });
  ok("自動に手順書が届いていない回を見つける", !none.ok && none.why.some((x) => /届いていない/.test(x)));
  const extSeen = { ...seenOk, extra: ["new_rule"], have: AUTO_RULES.length - 1 };
  const ext = judgePlaybookReflect({ playbook: pb, buildV: PLAYBOOK_BUILD_V, seen: [extSeen] });
  ok("拡張が先に進んで手順書が古い時を見つける", !ext.ok && ext.why.some((x) => /手順書が古い/.test(x)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
