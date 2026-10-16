// app/lib/quoted-viewing-target.ts（純関数・DB/LLM なし）
// AIX【内覧日調整】の物件名: お客様が引用返信で1件を指した時は、その1件だけにする。
//
// 2026-10-16 竹内悠馬（10/16 の画面の事例 d）: こちらが送った2件のうち1件（グランパシフィック桜川南902）を引用して「こちらの物件気になります」→
//   AIX 内覧日調整の文が「グランパシフィック桜川南902号室とセレッソコート西心斎橋III305号室の2部屋ご案内」。竹内さんの実送信は引用した1件だけ。
//   画面の物件名の欄は直前に送った束（2件）を入れていた。お客様がどの物件を対象にしているか（引用返信の物件）を読めていない。
// 決め: 物件名の欄に複数の物件があり、台帳（property-thread）の今の番の物件が引用（by=quote）の1件で、その物件が欄の中にある時は、その1件に絞る。
//   名指し・推定の時・欄に無い時は触らない（スタッフが選んだ欄を勝手に変えない）。戻す AIX_VIEWING_QUOTED_ONLY=off
import { splitPropertyName, matchRoomRefs } from "./customer-state";

export function viewingQuotedOnlyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AIX_VIEWING_QUOTED_ONLY ?? "").trim().toLowerCase() !== "off";
}

const SEP_RE = /\s*(?:、|，|,|・|／|\/|と|\n)\s*/;

export function narrowToQuotedProperty(propertyName: string | null | undefined, targets: ReadonlyArray<{ display: string; by: string }>): string | null {
  const raw = String(propertyName ?? "").trim();
  if (!raw) return null;
  const quoted = targets.filter((t) => t.by === "quote");
  const uniq = [...new Set(quoted.map((t) => t.display))];
  if (uniq.length !== 1) return null;
  const parts = raw.split(SEP_RE).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const target = splitPropertyName(uniq[0]);
  if (!target) return null;
  const hit = parts.find((p) => { const r = splitPropertyName(p); if (!r) return false; const k = matchRoomRefs(target, r); return k === "same_room" || (k === "same_building" && (!target.room || !r.room)); });
  return hit ?? null;
}
