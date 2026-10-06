// app/lib/__tests__/call-name-guard.test.ts — 呼び名の固定と出口の名前の直し（実行: npx tsx app/lib/__tests__/call-name-guard.test.ts）
// 2026-10-06 ⑫ 竹内「名前間違えているの絶対にいれない…こんかい あさんやのになぜこうなったのか」
import { enforceCallName, lockedCallName } from "../call-name-guard";
import { staffCalledName } from "../aix-staff-called-name";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// あ（10/06 16:29 の実物）
const DRAFT = "はい😊！！\n\nお部屋のご案内は30分程をみていただけますと幸いです！！\n\n森本様のご都合よろしいお日にちにてお申し付けください！！";
const STAFF = [
  { sender: "staff", text: "あさん\nお待たせいたしました！！\n\n本町・堺筋本町駅徒歩7分以内・白基調・ペット可…" },
  { sender: "staff", text: "あさん\n\n堺筋本町・本町・北浜・淀屋橋周辺全域から…" },
  { sender: "staff", text: "あさん\nお待たせいたしました！！\nお送り頂きました物件の中で…" },
];
{
  const called = staffCalledName(STAFF);
  t("スタッフが冒頭で2回以上呼んだ 1文字の「あ」を呼び名にする", called === "あ", called);
  const locked = lockedCallName({ stored: null, staffCalled: called, resolved: "" });
  t("固定の呼び名＝あ（スタッフが呼んだ名前）", locked.name === "あ" && locked.source === "staff_called");
  const g = enforceCallName(DRAFT, locked.name, STAFF.map((m) => m.text), ["あ"]);
  t("「森本様のご都合」→「あさんのご都合」", g.text.includes("あさんのご都合よろしいお日にち") && !g.text.includes("森本") && g.replaced.join() === "森本様", JSON.stringify(g));
}
t("保存した呼び名が一番強い（スタッフが画面で直した名前）", lockedCallName({ stored: "あいり", staffCalled: "あ", resolved: "" }).name === "あいり");
t("呼び名が無い → 呼びかけごと外す（「ご都合よろしいお日にち」）", (() => { const g = enforceCallName(DRAFT, "", [], []); return !g.text.includes("森本") && g.text.includes("\nご都合よろしいお日にちにてお申し付けください"); })());
// 触らない
t("固定の呼び名の呼びかけはそのまま", enforceCallName("あさん\nお待たせいたしました！！", "あ", [], []).replaced.length === 0);
t("会話に出てくる名前（紹介者・連名者）は触らない", enforceCallName("松崎さんのご紹介ありがとうございます！！", "あ", ["松崎夏鈴さんの紹介で連絡しました"], []).replaced.length === 0);
t("お客様・管理会社様・お疲れ様は名前でない", enforceCallName("お疲れ様です！！\n管理会社様に確認させて頂きます！！", "あ", [], []).replaced.length === 0);
t("文の切れ端（「新着であさんに」）は名前にしない", enforceCallName("🌟新着であさんにオススメ出来るお部屋が募集に出ました！！", "あ", [], []).replaced.length === 0);
t("表示名・登録名（許す名前）は触らない", enforceCallName("Yasukiさん\nお世話になっております！！", "yasuki", [], []).replaced.length === 0);
t("「〇〇さん」の作文の名前も直す（スタッフの手本の伏せ字）", enforceCallName("〇〇さんにオススメ出来るお部屋となります！！", "あ", [], []).text.startsWith("あさんにオススメ"));
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
