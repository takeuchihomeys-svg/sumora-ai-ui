// app/lib/aix-sent-names.ts
// 物件オススメ・物件送付の AIX で「どの物件を送ったか」の名前を決める（純関数・DB に触らない）。
//
// 2026-10-08 竹内「大丈夫」（返信の質 8巡目・記録）:
// ── 実データ（直近60日・グループと YUMA を除く）──
//   AIX【物件オススメ】531通: aix_usage_logs.property_names は 0通・sent_facts の物件名は 12通（2%）だけ。
//     名前は本文の1行目「🌟建物 101号室」にある（送った本文＝こちらが書いた事実）。
//   AIX【物件送付（ピックアップ）】302通: sent_facts の物件名は 13通（売上サポから送った時だけ）。
//     本文に名前は無い（「〇〇のご条件でピックアップさせて頂きました」）。名前は同じ時に送った資料の画像を読んだ記録
//     sent_properties にあり、297通中 245通で AIX の送信の前後数分に行がある（行の時刻は AIX の後 中央値4秒・9割18秒）。
// 戻す: AIX_SENT_NAMES=off
import { extractPropertyLabels, extractViewingAppointment } from "./action-ledger";
import { estimateNamesFromText } from "./customer-state";
import { estimateRecordItemsFromLog } from "./estimate-record-items";
import { isStarNameLine, starNameRoom } from "./closing-target";

export function aixSentNamesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AIX_SENT_NAMES ?? "").toLowerCase() !== "off";
}

/**
 * 🌟の本文 → 送った物件の名前。台帳（action-ledger.extractPropertyLabels）と同じ書き方「建物 101号室」にそろえる
 * （同じ物件が2件に数えられないように）。号室の無い🌟は建物名だけ。見積書の「🌟26,500円割引」は名前にしない。
 */
export function recommendationNamesFromText(text: string | null | undefined, max = 5): string[] {
  const t = String(text ?? "");
  if (!t.trim()) return [];
  const labels = extractPropertyLabels(t);
  if (labels.length) return labels.slice(0, max);
  const out: string[] = [];
  for (const line of t.split("\n")) {
    if (!isStarNameLine(line)) continue;
    const nr = starNameRoom(line);
    const name = nr?.name?.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out.slice(0, max);
}

export type SentPropertyRow = { property_name: string | null; room_no: string | null; sent_at: string | null; delivery?: string | null };

/** AIX の送信の前後（既定 5分前〜3分後）にお客様へ送った資料の記録の物件名（「建物 101号室」・重複なし・最大20） */
export function namesNearSend(rows: ReadonlyArray<SentPropertyRow>, sentAtIso: string, opts: { beforeMs?: number; afterMs?: number; max?: number } = {}): string[] {
  const t = Date.parse(sentAtIso);
  if (!Number.isFinite(t)) return [];
  const before = opts.beforeMs ?? 5 * 60_000;
  const after = opts.afterMs ?? 3 * 60_000;
  const out: string[] = [];
  const sorted = [...rows].sort((a, b) => String(a.sent_at ?? "").localeCompare(String(b.sent_at ?? "")));
  for (const r of sorted) {
    const at = Date.parse(String(r.sent_at ?? ""));
    if (!Number.isFinite(at) || at < t - before || at > t + after) continue;
    if (r.delivery && r.delivery !== "customer") continue;
    const name = String(r.property_name ?? "").trim();
    if (!name) continue;
    const room = String(r.room_no ?? "").trim();
    const label = room ? `${name} ${room.replace(/号室?$/, "")}号室` : name;
    if (!out.includes(label)) out.push(label);
  }
  return out.slice(0, opts.max ?? 20);
}

/**
 * 2026-10-08 8巡目（記録の続き・竹内「オススメした物件と、お客さんが送ってきた物件をちゃんと保管できていればできる」）:
 *   AIX の送信の記録（aix_usage_logs.property_names）に物件名（号室まで）を残す。画面から名前が来た時（物件確認した 等）はそちらが正。
 *   直近30日: property_names が入っていたのは 物件確認した 84/116 だけ（オススメ 0/278・物件送付 0/172・見積書 0/93・内覧調整 0/50・待ち合わせ 0/38）。
 *   ・物件オススメ … 🌟の行
 *   ・見積書送る … 本文の【建物 号室】（customer-state.estimateNamesFromText）・無ければ本文の「〇〇 101号室」
 *   ・待ち合わせ … 画面で選んだ物件（meeting_property_name）・無ければ本文の待ち合わせの場所
 *   ・内覧調整 … 本文の「建物 101号室」「🌟建物」（名前の無い候補日だけの文は付けない＝推測しない）
 *   ・物件送付 … 売上サポの名前（properties_sent_names）。無ければ送った後の資料の読み取りから（sent-facts.fillPropertySendNamesFromSentProperties）
 */
export function aixPropertyNamesForLog(o: {
  aixType: string | null | undefined; text: string | null | undefined;
  meetingPropertyName?: string | null; sentPropertyNames?: ReadonlyArray<string | null | undefined> | null;
}, env: Record<string, string | undefined> = process.env): string[] {
  if (!aixSentNamesEnabled(env)) return [];
  const t = String(o.text ?? "");
  const clean = (xs: ReadonlyArray<string | null | undefined>) => [...new Set(xs.map((x) => String(x ?? "").trim()).filter((x) => x.length >= 2))].slice(0, 10);
  switch (o.aixType) {
    case "property_recommendation":
      return recommendationNamesFromText(t);
    case "property_send":
      return clean(o.sentPropertyNames ?? []);
    case "estimate_sheet": {
      const names = estimateNamesFromText(t);
      if (names.length) return clean(names);
      const items = estimateRecordItemsFromLog({ aixType: "estimate_sheet", generatedText: t }, env).filter((i) => i.propertyName && i.source !== "aix_no_items");
      return clean(items.map((i) => (i.roomNo ? `${i.propertyName} ${i.roomNo}号室` : i.propertyName)));
    }
    case "meeting_place": {
      if (o.meetingPropertyName?.trim()) return clean([o.meetingPropertyName]);
      const ap = extractViewingAppointment(t, null);
      return ap?.place ? clean([ap.place]) : [];
    }
    case "viewing_invite":
      // 「🌟パークハイツアイリス2号館 のみご案内可能です」の後ろの文は名前にしない
      return clean(recommendationNamesFromText(t).map((n) => n.replace(/\s+(?:のみ|は|も|を|が|に|で)[\s\S]*$/, "").replace(/[😊😌🌟✨！!。、]+$/u, "")));
    default:
      return [];
  }
}
