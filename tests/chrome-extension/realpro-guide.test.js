// 実行: node tests/chrome-extension/realpro-guide.test.js
// 2026-10-01 竹内「光らせるようにする。今選択しているところを光らせるようにする」「そうすれば機械的な動きがなく人間が押す形となる」
//   「一度送ったことある物件などは出ないようにする。監視画面が判断する形で」
//   ① 手順表（realpro-guide-plan.js）の値の決め方が自動入力（page-script.js）と同じか
//   ② 案内（realpro-guide.js）が押さない・入れない・スクロールしないか（ファイルの中身で確かめる）
//   ③ 受け口（page-script.js）・manifest の並び・送付済みの部屋の口（background.js）・行の口（bulk-dl.js）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const P = require(path.join(dir, "realpro-guide-plan.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── ① page-script.js の表と同じか ──
const ps = read("page-script.js");
function tableOf(src, name) {
  const m = src.match(new RegExp("var " + name + "\\s*=\\s*(\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\});"));
  if (!m) return null;
  // eslint-disable-next-line no-new-func
  return Function("return " + m[1])();
}
for (const t of ["RENT_OPTS", "AGE_OPTS", "AREA_OPTS", "STRUCTURE_MAP", "FLOOR_MAP", "SLDK_SUBSTITUTE", "ROUTE_LINE_MAP"]) {
  ok("表 " + t + " が page-script.js と同じ", eq(tableOf(ps, t), P[t]), { ps: tableOf(ps, t) && Object.keys(tableOf(ps, t)).length, plan: P[t] && Object.keys(P[t]).length });
}
ok("賃料の丸め（下限は下・上限は上）", P.nearestDown(P.RENT_OPTS, 72000) === "70000" && P.nearestUp(P.RENT_OPTS, 100000) === "100000" && P.nearestUp(P.RENT_OPTS, 101000) === "110000");
ok("間取り: 2LDK", eq(P.floorPlanValues("2LDK", false), ["9"]));
ok("間取り: 広げて 2LDK → 2DK も", eq(P.floorPlanValues("2LDK", true), ["9", "8"]));
ok("間取り: 全角まじり「２K　2DK 2LDK」（v2.5.50 の実物）", eq(P.floorPlanValues("２K　2DK 2LDK", false), ["7", "8", "9"]));
ok("間取り: 1LDK以上", P.floorPlanValues("1LDK以上", false)[0] === "6" && P.floorPlanValues("1LDK以上", false).includes("21"));
ok("間取り: 1SLDK〜2LDK", eq(P.floorPlanValues("1SLDK〜2LDK", false), ["6", "8", "9"]));
ok("間取り: 「2LDKもしくは、ちょっと広めの1LDK」", eq(P.floorPlanValues("2LDKもしくは、ちょっと広めの1LDK", false), ["9", "6"]));
ok("場所: 駅 > 路線 > 区（auto）・area_mode の指定が先", P.locationMode({ station_names: ["中津"], city_codes: ["27127"] }) === "station"
  && P.locationMode({ area_mode: "ward", station_names: ["中津"], city_codes: ["27127"] }) === "area"
  && P.locationMode({ route_ids: ["6702"] }) === "route" && P.locationMode({}) === "none");

// チンシャンさんの形（2LDK・7〜10万・谷町線＋環状線）
{
  const plan = P.buildPlan({ rent_min: 70000, rent_max: 100000, floor_plan: "2LDK", route_ids: ["6702", "6603"], station_names: ["都島", "京橋"], area_mode: "station", is_wide: false });
  const kinds = plan.steps.map((s) => s.kind);
  ok("手順: … → 駅 → 検索（最初のお客様はリセットなし）", kinds[0] !== "reset" && kinds[kinds.length - 1] === "search" && kinds.includes("pick_station"), kinds);
  ok("前のお客様と違う時だけリセットが先頭（竹内「リセットは次のお客さんから」）", P.buildPlan({ rent_max: 100000 }, { withReset: true }).steps[0].kind === "reset");
  const st = plan.steps.find((s) => s.kind === "pick_station");
  ok("駅の手順に路線の名前（先に押す路線）", eq(st.lines, ["大阪市高速軌道谷町線", "大阪環状線"]), st);
  ok("賃料の手順の文", plan.steps.some((s) => s.name === "rental_cost2" && s.value === "100000" && /10万/.test(s.label)));
  ok("手順の id は重ならない", new Set(plan.steps.map((s) => s.id)).size === plan.steps.length);
}

// ── ② 案内は押さない・入れない・スクロールしない ──
const g = read("realpro-guide.js").replace(/\/\/.*$/gm, "");
ok("押す処理が無い（.click( / dispatchEvent / submit(）", !/\.click\s*\(|dispatchEvent|\.submit\s*\(/.test(g));
ok("値・チェックを入れない（.value = / .checked = / selectedIndex =）", !/\.value\s*=[^=]|\.checked\s*=[^=]|selectedIndex\s*=[^=]/.test(g));
ok("スクロールしない（scrollIntoView / scrollTo / scrollBy / scrollTop =）", !/scrollIntoView|scrollTo\s*\(|scrollBy\s*\(|scrollTop\s*=[^=]/.test(g));
ok("ページをめくらない・読み直さない（location / history）", !/location\.(href|assign|replace|reload)|history\.(back|go|push)/.test(g));
ok("「全ページ送る」を案内モードの間は止める", /axlx-auto-btn/.test(g) && /disabled\s*=\s*!!guideOn/.test(g));

// ── ③ つなぎ ──
ok("page-script: OFF の印（\"0\"）の時だけ自動入力・それ以外は案内に渡す", /getAttribute\("data-axlx-guide"\) !== "0"/.test(ps) && /from: "axlx-guide-start"/.test(ps));
ok("page-script: 案内に渡した回は完了の合図を返す（一括の待ちを止める）", /notifyDone\("guide-mode/.test(ps));
const mf = JSON.parse(read("manifest.json"));
const bi = mf.content_scripts.findIndex((c) => (c.js || []).includes("bulk-dl.js"));
const gi = mf.content_scripts.findIndex((c) => (c.js || []).includes("realpro-guide.js"));
const gjs = gi >= 0 ? mf.content_scripts[gi].js : [];
ok("manifest: 案内は一覧の部品（sent-skip・bulk-dl）の後の欄・手順表 → 案内 の順", bi >= 0 && gi > bi && gjs.indexOf("realpro-guide-plan.js") >= 0 && gjs.indexOf("realpro-guide-plan.js") < gjs.indexOf("realpro-guide.js"), { bi, gi, gjs });
ok("background: 送付済みの部屋の口（axlx-guide-sent-rooms）", /msg\.type === "axlx-guide-sent-rooms"/.test(read("background.js")));
ok("bulk-dl: 行の口（AxlxRealproRows）", /AxlxRealproRows\s*=/.test(read("bulk-dl.js")));

// ── ④ 2026-10-01 竹内「押したら勝手に自動検索始まって自動で物件ダウンロード始まってしまったから防ぐ」──
const bd = read("bulk-dl.js");
ok("bulk-dl: 案内モードの間は自動の送信・ページ送りを始めない（3か所）",
  /function autoSendAllPages\([^)]*\) \{\s*if \(_guideBlocksAuto\("autoSendAllPages"\)\) return;/.test(bd)
  && /function autoSendOnePage\([^)]*\) \{\s*if \(_guideBlocksAuto\("autoSendOnePage"\)\) return;/.test(bd)
  && /function tryNext\([^)]*\) \{\s*if \(_guideBlocksAuto\("tryNext"\)\) return;/.test(bd));
ok("bulk-dl: 読めない時も止める（明示の OFF＝false の時だけ動く）", /_guideOff = !!\(r && r\.guideMode === false\)/.test(bd) && /if \(_guideOff\) return false;/.test(bd));
const pp = read("popup.js");
ok("popup: 案内モードの間は再開の印（axlx_pending_auto_send）を置かない", /_gm\.guideMode !== false\) \{ try \{ chrome\.storage\.session\.remove\("axlx_pending_auto_send"\)/.test(pp));
ok("page-script: 検索を押す所（clickSearch・見積用）も案内モードの間は押さない", /function clickSearch\(\) \{\s*if \(_guideOn\(\)\)/.test(ps) && /if \(_guideOn\(\)\) \{ window\.__axlxEstimateSearchResult/.test(ps));

// ── ⑤ 2026-10-01 竹内「ここの一覧にリアプロ・ITANDI のボタン作って押したら反映されるように／監視画面がリアプロと判断できたらリアプロ」──
{
  const grab = (name) => { const m = pp.match(new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}")); return m ? m[0] : ""; };
  // eslint-disable-next-line no-new-func
  const mk = Function(grab("daysAgoText") + "\n" + grab("decideGuideNext") + "\nreturn decideGuideNext;")();
  const now = new Date().toISOString();
  const old = "2026-01-01T00:00:00Z";
  ok("次の検索: 何もしていない → リアプロのピンポイント", eq([mk({}).site, mk({}).mode], ["realpro", "pinpoint"]));
  ok("次の検索: リアプロのピンポイント済み → ITANDI のピンポイント", eq([mk({ realpro_p: now }).site, mk({ realpro_p: now }).mode], ["itandi", "pinpoint"]));
  ok("次の検索: 両サイトのピンポイント済み → リアプロの広げて", eq([mk({ realpro_p: now, itandi_p: now }).site, mk({ realpro_p: now, itandi_p: now }).mode], ["realpro", "wide"]));
  ok("次の検索: 昨日以前の検索は「まだ」扱い", mk({ realpro_p: old }).site === "realpro");
  ok("次の検索: 全部済み → なし", mk({ realpro_p: now, itandi_p: now, realpro_w: now, itandi_w: now }).site === null);
  ok("一覧: リアプロ・ITANDI の P／広 が押せる（レインズは除く）", /data-guide-site="' \+ s\.key \+ '" data-guide-mode="pinpoint"/.test(pp) && /s\.key !== "reins"/.test(pp) && /\.guide-btn/.test(pp));
  // v2.5.63: ITANDI の案内モードができた → 準備中の止めを外し、ITANDI もその検索の条件で案内を始める（詳しくは itandi-guide.test.js）
  ok("ITANDI: P・広 から ITANDI の案内を始める（準備中の止めは無い）", !/ITANDI の案内モードは準備中/.test(pp) && /if \(site !== "realpro" && site !== "itandi"\)/.test(pp) && /openInstructions\(site\);/.test(pp));
}

// ── ⑥ 2026-10-01 v2.5.59 キャッシュ確認（竹内「それで一度試す」）: 手元に無い資料はリアプロに取りに行かない ──
{
  const bg = read("background.js");
  const m = bg.match(/if \(msg\.type === "axlx-cache-probe"\) \{[\s\S]*?\n  \}\n/);
  const h = m ? m[0] : "";
  const fetches = h.match(/fetch\(/g) || [];
  ok("キャッシュ確認: 口がある・読み込みは1か所だけ", !!h && fetches.length === 1, fetches.length);
  ok("キャッシュ確認: 手元に残った物だけ（only-if-cached・same-origin）", /fetch\(u, \{ cache: "only-if-cached", mode: "same-origin"/.test(h));
  ok("キャッシュ確認: バーのボタン", /id="axlx-cache-btn"/.test(read("bulk-dl.js")) && /addEventListener\("click", probeCache\)/.test(read("bulk-dl.js")));
}

// ── 2026-10-02 v2.5.69 竹内「まだ送っていなくて通す物件は印刷用PDF光らせておく。送った物件も印刷用PDFが押せない（送付済み）に（お客さんに実際に送信した物件は）」──
{
  const rg = read("realpro-guide.js");
  ok("送付済みはお客様に届けた部屋だけ（customerRooms・★物件出し★への共有は使わない）", /customerIndex = Array\.isArray\(resp\.customerRooms\)/.test(rg) && /SK\.isSentRoom\(customerIndex, r\.name, r\.room\)/.test(rg));
  ok("送付済みの印刷用PDF は押すと確かめる（固く止めない）", /送付済みです。それでもダウンロードしますか？/.test(rg) && /document\.addEventListener\("click", function \(e\) \{\s*\r?\n\s*var t = e\.target && e\.target\.closest \? e\.target\.closest\("\.axlx-pdf-sent"\)/.test(rg));
  ok("光らせるのは「通す」（ブレインの下見）か、下見が無い時は ◎/○", /data-axlx-verdict/.test(rg) && /\^\[◎○\]/.test(rg));
  ok("案内を消すと印も消す", /if \(!guideOn\) clearPdfMarks\(\)/.test(rg) && /clearHighlight\(\); clearPdfMarks\(\); renderPanel\(\);/.test(rg));
  ok("押さない（.click( が無い）", !/\.click\s*\(/.test(rg.replace(/\/\/.*$/gm, "")));
  const bd = read("bulk-dl.js");
  ok("bulk-dl は下見の判定を印刷用PDF に印として残す・行の口に btn", /setAttribute\("data-axlx-verdict"/.test(bd) && /btn: t\.btn \|\| null/.test(bd));
  const bg = read("background.js");
  ok("background はお客様に届けた部屋（customer_rooms）を渡す", /customerRooms: j && Array\.isArray\(j\.customer_rooms\)/.test(bg));
  const pp = read("popup.js");
  ok("ピンポイントの後に「広げて検索」を光らせる（axlx_pinpoint_memo・押さない）", /function refreshWideGlow\(\)/.test(pp) && /axlx-wide-glow/.test(pp) && /memoSearchRun\(session, "realpro"\)/.test(rg));
}

// ── 2026-10-02 v2.5.71 竹内「この後賃料とか光るはずがひかっていない 原因みつける 駅選択したつぎが光らない」「印刷用pdfも光らせる」──
{
  const A = P.stationStepAction;
  // 実画面（ASA・沿線の設定 >> 駅の設定）: 塚本・御幣島に印・小窓に「確定してリストへ」「駅リセット」「設定へ戻る」
  ok("駅を全部選んだ・小窓が開いている → 「確定してリストへ」を光らせる（旧: 決定/OK/閉じる で何も光らなかった）", A({ visibleUnchecked: 0, visibleTargets: 2, anyChecked: true, modalOpen: true, lineBtns: 0 }) === "confirm");
  ok("小窓を閉じた・光る駅に印が残る → 済み（手で「済み」を押さない）", A({ visibleUnchecked: 0, visibleTargets: 0, anyChecked: true, modalOpen: false, lineBtns: 0 }) === "done");
  ok("スタッフが一部の駅だけ選んで閉じた → 済み", A({ visibleUnchecked: 0, visibleTargets: 0, anyChecked: true, modalOpen: false, lineBtns: 2 }) === "done");
  ok("まだの駅が見えている → 駅を光らせる", A({ visibleUnchecked: 1, visibleTargets: 2, anyChecked: true, modalOpen: true, lineBtns: 0 }) === "stations");
  ok("路線の画面（駅が見えない・印なし）→ 路線を光らせる", A({ visibleUnchecked: 0, visibleTargets: 0, anyChecked: false, modalOpen: true, lineBtns: 2 }) === "lines");
  ok("小窓が閉じていて印なし → 開く", A({ visibleUnchecked: 0, visibleTargets: 0, anyChecked: false, modalOpen: false, lineBtns: 0 }) === "open");
  ok("小窓の閉じるボタンの文字に「確定してリストへ」「×とじる」", P.STATION_MODAL_DONE_TEXTS.includes("確定してリストへ") && P.STATION_MODAL_DONE_TEXTS.includes("×とじる") && P.STATION_MODAL_OPEN_TEXTS.includes("駅リセット"));
  const rg2 = read("realpro-guide.js");
  ok("駅の手順は済みを覚える（小窓を閉じて印が読めなくなっても戻らない）", /if \(act === "done"\) \{ markStepDone\(s\.id\); return \{ done: true \}; \}/.test(rg2));
  ok("「確定してリストへ」等を押したら駅の手順を済みに（光る駅に1つでも印）", /closeHit && \(cur\.step\.kind === "pick_route" \|\| stationAnyChecked\(cur\.step\)\)/.test(rg2));
  ok("旧の「この手順を「済み」にしてください」を出さない", !/この手順を「済み」にしてください/.test(rg2));
  ok("画面が変わったらすぐ光を次の手順へ（MutationObserver → tick）", /_tickSoon = setTimeout\(function \(\) \{ _tickSoon = null; if \(!document\.hidden\) tick\(\); \}, 120\)/.test(rg2));
  // 駅の後の手順（賃料・面積・築年数・間取り・検索）が手順表に並ぶ（ASA の条件）
  const asa = P.buildPlan({ rent_min: 70000, rent_max: 150000, floor_plan: "2LDK〜3LDK", area_min: 40, building_age: 35, station_names: ["塚本", "御幣島"], route_ids: [], area_mode: "station" });
  const ks = asa.steps.map((x) => x.kind), iSt = ks.indexOf("pick_station");
  ok("ASA: 駅の後に賃料・面積・築年数・間取り・検索が続く", iSt >= 0 && asa.steps.slice(iSt + 1).some((x) => x.name === "rental_cost2") && asa.steps.slice(iSt + 1).some((x) => x.name === "structured_date") && ks[ks.length - 1] === "search", ks);

  // 印刷用PDF: 一覧で案内のお客様が無い（「拡張でお客様を選ぶと…」）→ 拡張の今のお客様で
  const R = P.resultsCustomerAction;
  ok("一覧・案内なし・拡張のお客様あり → 今のお客様で一覧の案内を作る（実画面の形）", R({ rows: 1, hasSession: false, stage: null, sessionCid: null, currentCid: "cus-1" }) === "adopt");
  ok("一覧・案内なし・お客様も無い → none（通すの光だけ）", R({ rows: 1, hasSession: false, stage: null, sessionCid: null, currentCid: "" }) === "none");
  ok("一覧ではない → none", R({ rows: 0, hasSession: false, stage: null, sessionCid: null, currentCid: "cus-1" }) === "none");
  ok("一覧で拡張のお客様を替えた → 合わせ直す", R({ rows: 3, hasSession: true, stage: "results", sessionCid: "cus-1", currentCid: "cus-2" }) === "switch");
  ok("同じお客様 → keep", R({ rows: 3, hasSession: true, stage: "results", sessionCid: "cus-1", currentCid: "cus-1" }) === "keep");
  ok("画面の変化のたびに一覧の印を付け直す（送付済みを読めていなくても）", /_hideTimer = null; if \(!document\.hidden\) \{ perf\.sync\+\+; syncResults\(\); \}/.test(rg2) && !/if \(!sentIndex \|\| _hideTimer\) return;/.test(rg2));
  ok("お客様が分からなくても「通す」の印刷用PDF は光らせる", /if \(act === "none"\) \{ markPdfButtons\(R\.list\(\)\); return; \}/.test(rg2));
  ok("案内の記録が消えていても一覧なら印を付ける", /SESSION_TTL_MS\) \{ setTimeout\(syncResults, 2500\); return; \}/.test(rg2));
  ok("光の CSS を markPdfButtons の中でも入れる", /if \(document\.body\) ensureLayer\(\);/.test(rg2));
  ok("下見の「通す」は印刷用PDF のボタンに付く（bulk-dl の data-axlx-verdict）", /x\.btn\.setAttribute\("data-axlx-verdict"/.test(read("bulk-dl.js")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
