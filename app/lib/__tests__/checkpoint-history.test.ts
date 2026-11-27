// npx tsx app/lib/__tests__/checkpoint-history.test.ts
// 2026-11-28 作業員L（統括役の決め3）: off の時はセーブデータの要約に渡す文が今までと1字も同じ・on の時だけ記入済みの申込フォームの中身を省く
import assert from "node:assert/strict";
import { checkpointHistoryText, APP_FORM_PLACEHOLDER } from "../checkpoint-history";
const fmt = (iso: string) => iso.slice(5, 16).replace("T", " ");
const msgs = [
  { sender: "customer", text: "2LDK で探しています", created_at: "2026-11-01T10:00:00Z" },
  { sender: "staff", text: "かしこまりました", created_at: "2026-11-01T10:05:00Z", is_aix_generated: false },
  { sender: "staff", text: "物件をお送りします", created_at: "2026-11-01T11:00:00Z", is_aix_generated: true },
  { sender: "customer", text: "【お申込者様記入欄】\n・氏名、フリガナ 架空太郎、カクウタロウ\n・生年月日 1999年2月3日\n・携帯番号 090-0000-0000", created_at: "2026-11-02T10:00:00Z" },
  { sender: "customer", text: null, created_at: "2026-11-02T10:01:00Z" },
  { sender: "customer", text: "あ".repeat(700), created_at: "2026-11-02T10:02:00Z" },
];
// 今までの組み立て（brain-core にあった式をそのまま写した物）
const old = msgs.map((m) => { const role = m.sender === "customer" ? "顧客" : ((m as { is_aix_generated?: boolean }).is_aix_generated ? "スタッフ(AIX)" : "スタッフ"); return `${role} ${fmt(m.created_at)}: ${(m.text ?? "").slice(0, 600)}`; }).join("\n");
assert.equal(checkpointHistoryText(msgs, fmt), old, "off（既定）は今までと1字も同じ");
assert.equal(checkpointHistoryText(msgs, fmt, { skipFilledForm: false }), old);
const on = checkpointHistoryText(msgs, fmt, { skipFilledForm: true });
assert.ok(on.includes(APP_FORM_PLACEHOLDER) && !on.includes("架空太郎") && !on.includes("090-0000-0000"), "on は記入済みフォームの中身を省く");
const heads = (t: string) => (t.match(/(?:^|\n)(?:顧客|スタッフ\(AIX\)|スタッフ) \d\d-\d\d /g) ?? []).length;
assert.equal(heads(on), msgs.length, "通の数は同じ（フォームは1行にまとめる）");
assert.ok(on.includes("2LDK で探しています") && on.includes("スタッフ(AIX)"), "ほかの通はそのまま");
console.log("checkpoint-history ok 6");
