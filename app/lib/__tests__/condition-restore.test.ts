// app/lib/__tests__/condition-restore.test.ts — LINE の言葉どおりに検索の条件を足す・入れ替える・元に戻す（実行: npx tsx app/lib/__tests__/condition-restore.test.ts）
// 2026-10-06 ⑫ 竹内さん（R・スモラ 10/03）「このように連絡きた場合物件検索の条件に反映させる。やっぱり元々の条件で等きたばあいは、もともとの条件に戻す」
// 2026-10-13: この試験は旧の順（文の語がブレインより先）を確かめる。既定のブレインの欄だけの形は condition-scope-brain-first.test.ts
process.env.CONDITION_SCOPE_BRAIN_FIRST = "off";
import {
  areaAskCue, areaMergeMode, areasBeforeNegation, areaAddedTokens, describeAreaChange, detectConditionRevert,
  planConditionRestore, planUndoLatestChange, placeTokens, groupConditionHistory, planUndoGroup, type RestoreHistoryRow,
} from "../condition-restore";
import { resolveConditionChangeScope, stripRevertedAutoNotes } from "../condition-change-scope";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

const R_TEXT = "詳細ありがとうございます！\n\nちなみに旭区、都島区、城東区、阿倍野区、今里方面で同じような条件でお部屋はありますか？";

// ── R: エリアの追加の依頼は切り替え側（ブレインの temporary より強い） ──
t("R の文 → エリアの追加の依頼", !!areaAskCue(R_TEXT));
{
  const d = resolveConditionChangeScope({ text: R_TEXT, brainScope: "temporary" });
  t("R の文 + ブレイン temporary → permanent（text_permanent_area_ask）", d.scope === "permanent" && d.by === "text_permanent_area_ask", JSON.stringify(d));
}
t("R の文 → 足す（今のエリアを残す）", areaMergeMode(R_TEXT) === "add");
t("塚本駅、加島駅では同じ価格帯の物件ありますか？ → エリアの追加の依頼", !!areaAskCue("塚本駅、加島駅では同じ価格帯の物件ありますか？"));
t("住吉区とかでも無いですか → エリアの追加の依頼", !!areaAskCue("住吉区とかでも無いですか😭"));
// 当たってはいけない物
t("時の「あたり」（土曜の午後あたりで空いている日はありますか）は当たらない", !areaAskCue("今週の土曜の午後か日曜の午前だと助かるのですが、そのあたりで空いている日はありますか？"));
t("9月中旬あたりで行けるとこ → 場所の語でない", placeTokens("9月中旬あたりで行けるとこ探して欲しいです").length === 0);
t("物件の URL つきは当たらない", !areaAskCue("https://www.homes.co.jp/chintai/b-1522840038291/ この物件は旭区でありますか？"));
t("1Kの方が通りやすかったりしますか（場所なし）は当たらない", !areaAskCue("ありがとうございます！ ちなみに1Kの方が通りやすかったりしますか？"));
t("「今回だけ天王寺区でもありますか」は今回だけが勝つ", resolveConditionChangeScope({ text: "今回だけ天王寺区でもありますか？" }).scope === "temporary");

// ── 足すか入れ替えるか ──
t("「エリアは変わり桜川エリアで探しております」→ 入れ替え", areaMergeMode("現在も探しておりまして、エリアは変わり桜川エリアで探しております") === "replace");
t("「梅田じゃなくて難波で」→ 入れ替え・梅田を外す", areaMergeMode("梅田じゃなくて難波で探してください") === "replace"
  && JSON.stringify(areasBeforeNegation("梅田じゃなくて難波で探してください", ["梅田", "難波"])) === JSON.stringify(["梅田"]));
t("「住吉区でも探して頂いてもいいですか」→ 足す", areaMergeMode("住吉区でも探して頂いてもいいですか？") === "add");

// ── 画面の帯の差分 ──
{
  const before = "忍ヶ丘駅周辺（車で30~40分圏内）";
  const after = "忍ヶ丘駅周辺（車で30~40分圏内）・今里・大阪市都島区・大阪市城東区・大阪市阿倍野区・大阪市旭区";
  t("足した語（大阪市を外して見せる）", JSON.stringify(areaAddedTokens(before, after)) === JSON.stringify(["今里", "都島区", "城東区", "阿倍野区", "旭区"]), JSON.stringify(areaAddedTokens(before, after)));
  t("帯の1行", describeAreaChange(before, after) === "エリア変更: +今里・都島区・城東区・阿倍野区・旭区", String(describeAreaChange(before, after)));
  t("入れ替えは − も出す", describeAreaChange("梅田", "難波") === "エリア変更: +難波 −梅田");
  const s = stripRevertedAutoNotes("[10/2 09:40|format] 正式条件フォーマット受信\n[10/3 13:31|auto] エリア変更: +今里・都島区", { desired_area: after });
  t("今回だけで戻した時は帯のエリア変更の行も外す", s.text === "[10/2 09:40|format] 正式条件フォーマット受信" && s.removed.length === 1, JSON.stringify(s));
}

// ── 元に戻す依頼 ──
t("「やっぱり元々の条件でお願いします」→ original・全列", detectConditionRevert("やっぱり元々の条件でお願いします")?.kind === "original"
  && (detectConditionRevert("やっぱり元々の条件でお願いします")?.fields.length ?? 0) >= 5);
t("「エリアは最初の希望に戻してください」→ original・エリアだけ", JSON.stringify(detectConditionRevert("エリアは最初の希望に戻してください")?.fields) === JSON.stringify(["desired_area"]));
t("「家賃を前の条件に戻してほしいです」→ previous・家賃だけ", detectConditionRevert("家賃を前の条件に戻してほしいです")?.kind === "previous"
  && JSON.stringify(detectConditionRevert("家賃を前の条件に戻してほしいです")?.fields) === JSON.stringify(["rent_max", "rent_min"]));
// 本番の実物（戻す依頼ではない）
t("「大国町エリアでも前送った条件でお探し」は戻す依頼でない（別の場所で同じ条件）", detectConditionRevert("大国町エリアでも前送った条件でお探しして頂きたいです！\n初期費用も10万以下だと助かります😭") === null);
t("「以前お伝えさせて頂いたエリアでめぼしいのがあれば」は戻す依頼でない", detectConditionRevert("竹内さんの方で以前お伝えさせて頂いたエリアでめぼしいのがあればまた教えて頂きたいです。") === null);
t("「以前の初期費用に10月分家賃が含まれてる」は戻す依頼でない", detectConditionRevert("以前の初期費用に10月分家賃が含まれてる認識でしょうか？") === null);
t("「天王寺でも元々の条件で」は戻す依頼でない", detectConditionRevert("天王寺区でも元々の条件で探してもらえますか？") === null);

// ── 履歴から戻す（R の実際の履歴の形） ──
const R_HIST: RestoreHistoryRow[] = [
  { changed_field: "desired_area", old_value: "忍ヶ丘駅周辺（車で30~40分圏内）", new_value: "忍ヶ丘駅周辺（車で30~40分圏内）・今里・大阪市都島区・大阪市城東区・大阪市阿倍野区・大阪市旭区", created_at: "2026-10-03T04:31:28Z", source_message_id: "path_c:98336d78-b383-4800-a8e7-fa35a3e16e6f" },
  { changed_field: "desired_area", old_value: "忍ヶ丘駅周辺（車で30~40分圏内）・今里・大阪市都島区・大阪市城東区・大阪市阿倍野区・大阪市旭区", new_value: "忍ヶ丘駅周辺（車で30~40分圏内）", created_at: "2026-10-03T04:31:52Z", source_message_id: "scope:temporary（brain）" },
  { changed_field: "desired_area", old_value: "忍ヶ丘駅周辺（車で30~40分圏内）", new_value: "旭区・都島区・城東区・阿倍野区・今里", created_at: "2026-10-03T07:43:01Z", source_message_id: "screen_edit" },
  { changed_field: "desired_area", old_value: "旭区・都島区・城東区・阿倍野区・今里", new_value: "浪速区", created_at: "2026-10-04T08:36:21Z", source_message_id: "screen_edit" },
];
{
  const cur = { desired_area: "浪速区", rent_max: 100000 };
  const o = planConditionRestore(R_HIST, cur, { kind: "original", fields: ["desired_area", "rent_max"] });
  t("元々 → 最初の希望エリア（忍ヶ丘駅周辺）", o.updates.desired_area === "忍ヶ丘駅周辺（車で30~40分圏内）" && !("rent_max" in o.updates), JSON.stringify(o));
  const p = planConditionRestore(R_HIST, cur, { kind: "previous", fields: ["desired_area"] });
  t("前 → 1つ前（旭区・都島区…）", p.updates.desired_area === "旭区・都島区・城東区・阿倍野区・今里", JSON.stringify(p));
  const u = planUndoLatestChange(R_HIST, cur);
  t("元に戻す（画面）→ 一番新しい変更の前", u.updates.desired_area === "旭区・都島区・城東区・阿倍野区・今里", JSON.stringify(u.updates));
  const u2 = planUndoLatestChange(R_HIST, { desired_area: "西区" });
  t("後で変わっている列は戻さない", !("desired_area" in u2.updates) && u2.skipped.length === 1, JSON.stringify(u2));
}
{
  // 正式フォーマットを送り直した人は、その値が「元々」
  const hist: RestoreHistoryRow[] = [
    { changed_field: "rent_max", old_value: null, new_value: "80000", created_at: "2026-09-01T00:00:00Z", source_message_id: "format:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    { changed_field: "rent_max", old_value: "80000", new_value: "90000", created_at: "2026-09-10T00:00:00Z", source_message_id: "format:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
    { changed_field: "rent_max", old_value: "90000", new_value: "120000", created_at: "2026-09-20T00:00:00Z", source_message_id: "p4:cccccccc-cccc-cccc-cccc-cccccccccccc" },
  ];
  const o = planConditionRestore(hist, { rent_max: 120000 }, { kind: "original", fields: ["rent_max", "rent_min"] });
  t("元々 → 一番新しい正式フォーマットの値（9万）・数字で戻す", o.updates.rent_max === 90000, JSON.stringify(o));
  // 戻す先が空（初めて入った列）は消さない
  const e = planConditionRestore([{ changed_field: "floor_plan", old_value: null, new_value: "1K", created_at: "2026-09-20T00:00:00Z", source_message_id: "p4" }], { floor_plan: "1K" }, { kind: "previous", fields: ["floor_plan"] });
  t("戻す先が空の列は消さない（誤削除0）", !("floor_plan" in e.updates) && e.skipped.length === 1, JSON.stringify(e));
}

// 2026-10-13 竹内さん（未桜）: 条件の更新の履歴（日時付き・新しい順）と、行ごとの「元に戻す」「確認済み」
{
  // 未桜の実物の並び（条件の値だけ）
  const rows = [
    { changed_field: "floor_plan", old_value: "1LDK", new_value: "1K 1LDK", created_at: "2026-09-21T09:48:03Z", source_message_id: null },
    { changed_field: "rent_max", old_value: "90000", new_value: "80000", created_at: "2026-09-27T12:24:14Z", source_message_id: "manual:2026-09-27 竹内さん指示" },
    { changed_field: "floor_area_min", old_value: "25", new_value: "19", created_at: "2026-09-27T12:24:14Z", source_message_id: "manual:2026-09-27 竹内さん指示" },
    { changed_field: "desired_area", old_value: "大国町", new_value: "浪速区", created_at: "2026-10-06T09:25:56Z", source_message_id: "screen_edit" },
    { changed_field: "preferences", old_value: "7畳以上の部屋", new_value: "7畳以上の部屋・独立洗面台", created_at: "2026-10-10T04:54:36Z", source_message_id: "brain_bridge:a1" },
    { changed_field: "other_requests", old_value: "共益費込みで8万未満希望", new_value: "7畳以上の部屋、共益費込みで8万未満希望、独立洗面台", created_at: "2026-10-10T04:54:38Z", source_message_id: "condition_brain:a1" },
  ] as Array<RestoreHistoryRow & { confirmed_at?: string | null }>;
  const cur = { desired_area: "浪速区", rent_max: 80000, floor_area_min: 19, floor_plan: "1K 1LDK" };
  const g = groupConditionHistory(rows, cur);
  t("新しい順に束（同じ発言・2分以内は1行＝ブレインの2行は1つ・書き手が違えば別）", g.length === 4 && g[0].writerJa === "ブレイン" && g[0].changes.length === 2 && g[1].writerJa === "画面で直した" && g[2].changes.length === 2, JSON.stringify(g.map((x) => [x.writerJa, x.changes.length])));
  t("条件の列の束は元に戻せる・希望だけの束は戻せない", g[1].undoable === true && g[0].undoable === false, JSON.stringify(g.map((x) => x.undoable)));
  const u = planUndoGroup(rows, cur, g[2].key);
  t("古い束も元に戻せる（今の値がその束の値のまま）", u.updates.rent_max === 90000 && u.updates.floor_area_min === 25, JSON.stringify(u));
  const u2 = planUndoGroup(rows, { ...cur, rent_max: 75000 }, g[2].key);
  t("後で変わった列は戻さない", !("rent_max" in u2.updates) && u2.updates.floor_area_min === 25, JSON.stringify(u2));
  const rows2 = rows.map((r) => r.changed_field === "desired_area" ? { ...r, confirmed_at: "2026-10-07T00:00:00Z" } : r);
  const g2 = groupConditionHistory(rows2, cur);
  t("確認済みはその束とそれより古い束・新しい束はまだ", g2[1].confirmed && g2[2].confirmed && g2[3].confirmed && !g2[0].confirmed, JSON.stringify(g2.map((x) => x.confirmed)));
}

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
