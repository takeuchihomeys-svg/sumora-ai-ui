// app/lib/property-thread.ts
// 物件ごとの状況の台帳（1つの会話で出た物件1件ずつの出来事と今の状況）＋今の番がどの物件の話か（純関数・DB に触らない）。
//
// 2026-10-07 竹内（S❤ 10/7 01:24 の見張り「事実違い: 物件」）:
//   「物件ごとに状況を把握できていたら、出来る、今物件の事把握できていないのかもしれない。物件にたいして反応や進捗があれば
//    1件ずつそのデータ保管して、物件の事にたいしての話になったときは、状況を理解出来るようにした方が良い」
//
// 【実物で追った出所】（会話 d3a56a97・10/6〜10/7）
//   13:15 こちらが4件の資料を送った（クリエオーレ私市山手104・ポルテ・ボヌールB棟0203・クリエオーレ一津屋Ⅱ103・フェリオ永田101）
//   13:58 お客様「こちらの初期費用知りたいです」＝フェリオ永田101 の資料の**引用**
//   19:21 AIX【物件確認した】画像3枚＋「シャーメゾン フェリシード 101号室 募集中・見積書同封」（記録の物件名は「物件①」「シャーメゾン フェリシード 101号室」）
//   01:24 お客様「こちら礼金は少し安くなったりは」＝19:21 の**名前の無い画像**（見積書）の引用／「あとこちらの詳細も」＝一津屋Ⅱ103 の資料の引用
//   AI の案は「シャーメゾン フェリシード 101号室の礼金について減額交渉」（本文に名前が出ていた方に寄せた）、
//   スタッフは「ファリオ永田の礼金について減額交渉」＝13:58 に初期費用を聞かれた物件の見積書だった。
//   ブレインには引用先が「[画像]」としか渡らない（quoted-context は sent_image_properties にある資料の画像だけ物件に直せる。
//   AIX の見積書の画像は記録が無い）＝物件ごとの「聞かれた→見積→交渉」のつながりが材料に無かった。
//
// 【作り】二重管理にしない: 名前の寄せ方は customer-state（splitPropertyName / matchRoomRefs）、画像→物件は送った時の記録
//   （sent_image_properties / sent_properties）、出来事は messages・aix_usage_logs・estimate_records をその場で読んで並べる（新しい表は作らない）。
//   AIX の画像で名前の記録が無い物は、同じ AIX の物件名（property_names）のうち画像の記録が無い1件に寄せる。
//   物件名が「物件①」等の仮の名前なら、その AIX より前にお客様が費用・募集状況を聞いて答えがまだの物件に寄せる（inferred＝推定と書く）。
//
// 戻す: PROPERTY_THREAD_NOTE=off（ブレイン・返信の材料に入れない）
import { splitPropertyName, matchRoomRefs, buildingKeyOf, type RoomRef } from "./customer-state";
import { jstParts } from "./jst-date";

export function propertyThreadEnabled(): boolean {
  return (process.env.PROPERTY_THREAD_NOTE ?? "").toLowerCase() !== "off";
}

export type PtMsg = {
  sender: string; text: string | null; created_at: string;
  line_message_id?: string | null; quoted_message_id?: string | null; image_url?: string | null; is_aix_generated?: boolean | null;
};
export type PtAix = {
  created_at: string; aix_type: string | null; check_pattern?: string | null;
  property_names?: string[] | null; prop_statuses?: string[] | null; estimate_sent?: boolean | null; generated_text?: string | null;
};
export type PtEstimate = { created_at: string; property_name: string | null; room_no: string | null };
export type PtInput = {
  messages: ReadonlyArray<PtMsg>;
  /** 画像 URL → 送った物件の名前（sent_image_properties → sent_properties の順） */
  imageLabels: ReadonlyMap<string, string>;
  aix?: ReadonlyArray<PtAix>;
  estimates?: ReadonlyArray<PtEstimate>;
};

export type PtTopic = "cost" | "discount" | "detail" | "vacancy" | "viewing" | "photo" | "like" | "ng" | "other";
export type PtEventKind =
  | "sent" | "customer_shared" | "customer_ask" | "check_available" | "check_vacating" | "check_ended" | "estimate"
  | "staff_negotiating" | "staff_checking" | "staff_result";
export type PtEvent = { at: string; kind: PtEventKind; topic?: PtTopic; by: "quote" | "named" | "record" | "inferred"; text?: string };
export type PtRoom = { key: string; ref: RoomRef; names: string[]; events: PtEvent[]; sentByUs: boolean };
export type PtTurnTarget = { roomKey: string; display: string; topic: PtTopic; by: "quote" | "named" | "inferred"; customerText: string; at: string };
export type PropertyThreadState = { rooms: PtRoom[]; turnTargets: PtTurnTarget[] };

const PLACEHOLDER_RE = /^(?:物件|お部屋)\s*[①-⑳0-9０-９]*$/;
const TOPIC_RES: Array<[PtTopic, RegExp]> = [
  ["discount", /礼金|敷金|安く|値下|減額|交渉|割引|まけ|下げ/],
  ["cost", /初期費用|費用|見積|いくら|金額|総額/],
  ["photo", /写真|動画|画像/],
  ["vacancy", /空き|空いて|募集|まだあり|残って|埋まっ/],
  ["viewing", /内覧|内見|見に行|見学/],
  ["detail", /詳細|詳しく|間取り|設備|情報/],
  ["ng", /なし|無しで|やめ|微妙|厳し|合わな|違う/],
  ["like", /いい|良い|良さ|気になる|素敵|好き|ここで/],
];
export function topicOf(text: string): PtTopic {
  const t = String(text ?? "");
  for (const [k, re] of TOPIC_RES) if (re.test(t)) return k;
  return "other";
}
const STATUS_KIND: Record<string, PtEventKind> = { available: "check_available", vacating: "check_vacating", unavailable: "check_ended", ended: "check_ended" };
const NEGOTIATE_RE = /交渉/;
const CHECK_PROMISE_RE = /確認(?:させて|致し|いたし|し)[^\n。！!]{0,20}(?:ます|次第)/;
const RESULT_RE = /(?:とのご返事|とのご返答|とのことでした|難しい|出来ません|できません|可能です|可能との)/;

const ms = (iso: string) => Date.parse(iso);
const isImage = (m: PtMsg) => !!m.image_url || /^\s*\[画像\]/.test(m.text ?? "");

/** JST の「10/6 13:58」 */
export function jstShort(iso: string): string {
  const p = jstParts(iso);
  return `${p.m}/${p.d} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function resolvePropertyThreads(input: PtInput): PropertyThreadState {
  const rooms: PtRoom[] = [];
  const msgs = [...input.messages].sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const byLmid = new Map<string, PtMsg>();
  for (const m of msgs) if (m.line_message_id) byLmid.set(m.line_message_id, m);

  const findRoom = (ref: RoomRef): PtRoom | null => {
    for (const r of rooms) { const k = matchRoomRefs(ref, r.ref); if (k === "same_room" || (k === "same_building" && (!ref.room || !r.ref.room))) return r; }
    return null;
  };
  const roomOf = (name: string | null | undefined, sentByUs: boolean): PtRoom | null => {
    if (!name || PLACEHOLDER_RE.test(name.trim())) return null;
    const ref = splitPropertyName(name);
    if (!ref) return null;
    const hit = findRoom(ref);
    if (hit) { if (!hit.names.includes(ref.display)) hit.names.push(ref.display); if (!hit.ref.room && ref.room) hit.ref = ref; hit.sentByUs ||= sentByUs; return hit; }
    const r: PtRoom = { key: `${ref.buildingKey}#${ref.room ?? ""}`, ref, names: [ref.display], events: [], sentByUs };
    rooms.push(r);
    return r;
  };
  const push = (r: PtRoom | null, e: PtEvent) => {
    if (!r) return;
    // 同じ種類の出来事が10分以内に重なったら1つ（束で送った画像の重複）
    if (r.events.some((x) => x.kind === e.kind && x.topic === e.topic && Math.abs(ms(x.at) - ms(e.at)) < 10 * 60_000)) return;
    r.events.push(e);
  };

  // ① 送った資料の画像（記録のある物）
  const imageRoom = new Map<string, PtRoom>(); // message の line_message_id or image_url → 物件
  for (const m of msgs) {
    if (m.sender !== "staff" || !m.image_url) continue;
    const label = input.imageLabels.get(m.image_url);
    const r = roomOf(label, true);
    if (!r) continue;
    imageRoom.set(m.line_message_id ?? m.image_url, r);
    push(r, { at: m.created_at, kind: "sent", by: "record" });
  }

  // ② AIX の記録（物件確認の結果・見積書）。名前の記録が無い画像は同じ AIX の物件名に寄せる
  const placeholderImages: Array<{ msg: PtMsg; aixAt: string }> = [];
  for (const a of [...(input.aix ?? [])].sort((x, y) => ms(x.created_at) - ms(y.created_at))) {
    const names = (a.property_names ?? []).map((n) => String(n ?? "").trim());
    const sts = a.prop_statuses ?? [];
    const named: Array<PtRoom | null> = names.map((n) => roomOf(n, false));
    names.forEach((n, i) => {
      const r = named[i];
      if (!r) return;
      const k = STATUS_KIND[String(sts[i] ?? "")];
      if (a.aix_type === "property_check_result" && k) push(r, { at: a.created_at, kind: k, by: "record" });
      if (a.estimate_sent) push(r, { at: a.created_at, kind: "estimate", by: "record" });
    });
    if (a.aix_type === "estimate_sheet") {
      for (const mm of String(a.generated_text ?? "").matchAll(/【([^】\n]{2,40})】/g)) push(roomOf(mm[1], false), { at: a.created_at, kind: "estimate", by: "record" });
    }
    // この AIX の画像（AIX の記録の 20 秒前〜記録の時刻・スタッフの画像）を、物件名の並び（property_names の順）に寄せる。
    //   AIX は物件ごとに画像を続けて送る（資料→見積書）。記録のある画像を目印に、目印より前の画像は前の物件・後ろは目印の物件。
    //   目印が無く、画像の数が物件の数で割り切れる時は均等に分ける（c024b7b9: 画像4枚・2件＝前2枚が1件目）。どちらでもなければ寄せない（推測しない）
    const burst = msgs.filter((m) => m.sender === "staff" && isImage(m) && m.is_aix_generated !== false
      && ms(m.created_at) <= ms(a.created_at) + 2000 && ms(m.created_at) >= ms(a.created_at) - 20_000);
    if (!burst.length || !names.length) continue;
    const idOf = (m: PtMsg) => m.line_message_id ?? m.image_url ?? "";
    const anchorIdx = burst.map((m) => { const r = imageRoom.get(idOf(m)); return r ? named.findIndex((x) => x === r) : -1; });
    const assign = (m: PtMsg, slot: number) => {
      if (slot < 0 || slot >= names.length || imageRoom.has(idOf(m))) return;
      const r = named[slot];
      if (r) imageRoom.set(idOf(m), r);
      else if (PLACEHOLDER_RE.test(names[slot])) placeholderImages.push({ msg: m, aixAt: a.created_at });
    };
    if (anchorIdx.some((i) => i >= 0)) {
      const firstAnchor = anchorIdx.findIndex((i) => i >= 0);
      let cur = -1;
      burst.forEach((m, j) => {
        if (anchorIdx[j] >= 0) { cur = anchorIdx[j]; return; }
        if (j < firstAnchor) { if (anchorIdx[firstAnchor] === 1) assign(m, 0); return; } // 目印より前の物件が1件だけの時
        assign(m, cur);
      });
    } else if (burst.length % names.length === 0) {
      const k = burst.length / names.length;
      burst.forEach((m, j) => assign(m, Math.floor(j / k)));
    }
  }

  for (const e of input.estimates ?? []) push(roomOf(e.room_no ? `${e.property_name ?? ""} ${e.room_no}号室` : e.property_name, false), { at: e.created_at, kind: "estimate", by: "record" });

  // ③ お客様の発言（引用・名指し）と、スタッフの手打ち（交渉・確認・結果）
  const customerAsks: Array<{ r: PtRoom; at: string; topic: PtTopic }> = [];
  const resolvePlaceholder = (aixAt: string): PtRoom | null => {
    // 仮の名前の画像＝その AIX より前に、お客様が費用・募集状況を聞き、まだ見積・確認の結果が無い物件（一番新しい物）
    const cands = customerAsks.filter((c) => ms(c.at) < ms(aixAt) && (c.topic === "cost" || c.topic === "vacancy" || c.topic === "discount")
      && !c.r.events.some((e) => (e.kind === "estimate" || e.kind.startsWith("check_")) && ms(e.at) > ms(c.at) && ms(e.at) <= ms(aixAt) && e.by !== "inferred"));
    return cands.length ? cands[cands.length - 1].r : null;
  };
  const roomsNamedIn = (text: string): PtRoom[] => {
    // 照合は建物の鍵と同じ形（長音・記号・空白を外す）にそろえる
    const t = buildingKeyOf(text);
    return rooms.filter((r) => r.ref.buildingKey.length >= 3 && t.includes(r.ref.buildingKey));
  };
  for (const m of msgs) {
    if (m.sender === "customer") {
      const text = String(m.text ?? "");
      const q = m.quoted_message_id ? byLmid.get(m.quoted_message_id) : undefined;
      let target: PtRoom | null = null; let by: PtEvent["by"] = "quote";
      if (q) {
        target = imageRoom.get(q.line_message_id ?? q.image_url ?? "") ?? null;
        if (!target) {
          const ph = placeholderImages.find((p) => p.msg === q);
          if (ph) { target = resolvePlaceholder(ph.aixAt); by = "inferred"; }
        }
        if (!target && q.text) target = roomsNamedIn(q.text)[0] ?? null;
      }
      if (!target) { const named = roomsNamedIn(text); if (named.length === 1) { target = named[0]; by = "named"; } }
      if (!target) continue;
      // 画像の書き起こし（ポータルの画面・資料）は文の中の「敷金」等で話題を読まない＝お客様が物件を送ってきた（ゆなまる 10/6「シャーメゾン ソレイユ」の画面）
      if (/^\s*\[画像\]/.test(text)) { push(target, { at: m.created_at, kind: "customer_shared", by }); continue; }
      const topic = topicOf(text);
      push(target, { at: m.created_at, kind: "customer_ask", topic, by, text: Array.from(text.replace(/\s+/g, " ")).slice(0, 40).join("") });
      customerAsks.push({ r: target, at: m.created_at, topic });
    } else if (m.sender === "staff" && m.text && !isImage(m)) {
      const named = roomsNamedIn(m.text);
      if (named.length !== 1) continue;
      const r = named[0];
      if (RESULT_RE.test(m.text) && /(?:交渉|確認)させて(?:頂|いただ)きました|ご返事|ご返答/.test(m.text)) push(r, { at: m.created_at, kind: "staff_result", by: "named", text: Array.from(m.text.replace(/\s+/g, " ")).slice(0, 60).join("") });
      else if (NEGOTIATE_RE.test(m.text)) push(r, { at: m.created_at, kind: "staff_negotiating", by: "named" });
      else if (CHECK_PROMISE_RE.test(m.text)) push(r, { at: m.created_at, kind: "staff_checking", by: "named" });
    }
  }
  // 仮の名前の画像に付いた見積・確認を、推定した物件にも付ける（お客様の引用が来た時に分かる）
  for (const p of placeholderImages) {
    const r = resolvePlaceholder(p.aixAt);
    if (r) push(r, { at: p.aixAt, kind: "estimate", by: "inferred" });
  }
  for (const r of rooms) r.events.sort((a, b) => ms(a.at) - ms(b.at));

  // ④ 今の番（最後のスタッフの発言より後のお客様の発言）がどの物件の話か
  const lastStaffAt = [...msgs].reverse().find((m) => m.sender === "staff")?.created_at;
  const turnTargets: PtTurnTarget[] = [];
  for (const r of rooms) {
    for (const e of r.events) {
      if ((e.kind !== "customer_ask" && e.kind !== "customer_shared") || (lastStaffAt && ms(e.at) <= ms(lastStaffAt))) continue;
      turnTargets.push({ roomKey: r.key, display: r.ref.display, topic: e.topic ?? "other", by: e.by === "record" ? "quote" : e.by, customerText: e.text ?? "", at: e.at });
    }
  }
  turnTargets.sort((a, b) => ms(a.at) - ms(b.at));
  return { rooms, turnTargets };
}

const TOPIC_JA: Record<PtTopic, string> = { cost: "初期費用", discount: "礼金・費用の値下げ", detail: "詳細", vacancy: "募集状況", viewing: "内覧", photo: "写真", like: "気に入った様子", ng: "合わない様子", other: "このお部屋の話" };
const KIND_JA: Record<PtEventKind, string> = {
  sent: "こちらが資料を送った", customer_shared: "お客様が送ってきた", customer_ask: "お客様", check_available: "確認の結果 募集中",
  check_vacating: "確認の結果 退去予定", check_ended: "確認の結果 募集終了", estimate: "見積書を送った",
  staff_negotiating: "こちらが交渉中と伝えた", staff_checking: "こちらが確認中と伝えた", staff_result: "結果を伝えた",
};
function eventLine(e: PtEvent): string {
  const head = e.kind === "customer_ask" ? `お客様「${e.text ?? ""}」（${TOPIC_JA[e.topic ?? "other"]}）` : e.kind === "customer_shared" ? "お客様がこの物件の画面・資料を送ってきた" : KIND_JA[e.kind];
  return `${jstShort(e.at)} ${head}${e.by === "inferred" ? "（推定）" : ""}`;
}

/**
 * ブレイン・返信の材料（今の番が物件の話の時だけ）。今の番の物件を先に、その物件の出来事を時刻順に。
 * 同じ会話で状況が動いた他の物件（見積・確認・交渉・お客様の反応があった物）を短く添える（最大 maxOthers 件）。
 */
export function buildPropertyThreadNote(s: PropertyThreadState, opts: { maxOthers?: number; maxEvents?: number } = {}): string {
  if (!s.turnTargets.length) return "";
  const maxEvents = opts.maxEvents ?? 6;
  const targetKeys = [...new Set(s.turnTargets.map((t) => t.roomKey))];
  const lines: string[] = ["【🏠 物件ごとの状況（この会話の台帳・今の番の物件を先に）】"];
  for (const k of targetKeys) {
    const r = s.rooms.find((x) => x.key === k);
    if (!r) continue;
    const ts = s.turnTargets.filter((t) => t.roomKey === k);
    const how = ts.map((t) => `${TOPIC_JA[t.topic]}${t.by === "quote" ? "・引用" : t.by === "inferred" ? "・引用先は名前の無い画像→推定" : "・名指し"}`).join("／");
    lines.push(`▶ 今の番の物件: ${r.ref.display}（${how}）${r.names.length > 1 ? ` 別の書き方: ${r.names.filter((n) => n !== r.ref.display).join("・")}` : ""}`);
    for (const e of r.events.slice(-maxEvents)) lines.push(`  ・${eventLine(e)}`);
    // 今の番の「こちら」がどの物件かを1行で（引用先が名前の無い見積書の画像でも、根拠と一緒に名前を渡す）
    for (const t of ts) {
      const why = t.by === "inferred" ? "（引用先はこちらが送った見積書の画像・その前にお客様が初期費用を聞いた物件の見積書と推定）" : t.by === "quote" ? "（引用先の画像の物件）" : "（物件名の名指し）";
      lines.push(`  → お客様「${t.customerText}」の「こちら」＝${r.ref.display}${why}`);
    }
  }
  const others = s.rooms.filter((r) => !targetKeys.includes(r.key) && r.events.some((e) => e.kind !== "sent"))
    .sort((a, b) => ms(b.events.at(-1)!.at) - ms(a.events.at(-1)!.at)).slice(0, opts.maxOthers ?? 3);
  if (others.length) {
    lines.push("（同じ会話の他の物件・今の番の話ではない）");
    for (const r of others) { const e = r.events.filter((x) => x.kind !== "sent").at(-1)!; lines.push(`・${r.ref.display}: ${eventLine(e)}`); }
  }
  lines.push("⚠ お客様が今話している物件は ▶ の物件（「こちら」は → の行の物件）。その物件の約束・答えは ▶ の物件名で書き、同じ会話の他の物件（直前の AIX の本文に名前が出ていた物件を含む）と取り違えない。");
  return lines.join("\n");
}
