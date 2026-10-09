// scripts/audit-hidden-subject.ts — 主語の抜けたお客様の発言で、ブレイン・下書きが竹内さんと同じ物を指していたか（読み取りのみ・LLM なし・$0）
//
// 2026-10-09 竹内「主語が抜けていた場合、その主語は何のことなのか把握できるようになっているか。隠れた主語を見極める力」
//   例「空いてますか？」「いくらですか？」「見れますか？」「ペット大丈夫ですか」「これにします」「2人でも住めますか」「来週行けます」
//
// 正解: 竹内さん（messages.staff_writer='takeuchi'）の次の返事（次のお客様の発言まで・24h 以内）が指していた物件
//   ＝返事の本文・返事の画像（sent_image_properties/sent_properties）・返事の AIX（aix_usage_logs.property_names）に出た建物がちょうど1つの時だけ。
//   話題（時期・人の型）は返事の語の組（内覧／入居／人数・同行／空き／費用）がちょうど1つの時だけ。決まらない番は数えない。
// 比べる物: ブレイン（brain_decision_logs.digest の prop・q・dir）／下書き（line_watch_turns.draft_* → 無ければ ai_reply_examples.ai_draft）
//   さらに今の仕組みで材料に届いていたか: 台帳（property-thread の turnTargets）・20通の窓・引用・決定論の候補（試案）の当たり。
// 申込の書類が出た会話はその手前で切る（test-pii-guard.cutBeforeApplicationMaterial）。テスト・社内の会話は外す。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-hidden-subject.ts [--days=60] [--examples=3] [--json=scripts/.replay-out/hidden-subject.json] [--no-thread]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const flag = (k: string) => process.argv.includes(`--${k}`);
const one = (s: string, n = 120) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; line_message_id: string | null; quoted_message_id: string | null; is_aix_generated: boolean | null; staff_writer: string | null };
type Aix = { conversation_id: string; created_at: string; sent_at: string | null; aix_type: string | null; property_names: string[] | null };
type Room = { key: string; display: string };

// ── 主語の抜けの判定（決定論） ──
/** 主語が要る述語・指示語（物件・話題・人を言わずに聞く／決める形） */
const PRED_RE = /空いて|空き|まだあり|募集|いくら|初期費用|費用|家賃|見れ|見られ|見に行|内覧|内見|見学|ペット|これに(?:し|決)|こちらに(?:し|決)|ここに(?:し|決)|これで|ここで|そこで|決め|やめ|辞め|止め|キャンセル|見送|住め|入居|二人|2人|２人|ふたり|同棲|同居|彼女|彼氏|家族|行け|いけ(?:ます|る)|伺え|大丈夫|可能|でき(?:ます|る)|あります|どう(?:です|でしょう)|こちら|これ|ここ|それ|そちら|そこ|あれ|気になり/;
/** 物件・部屋を自分で言っている（主語あり）＝外す */
const NAMED_RE = /号室|https?:\/\/|[0-9０-９]{3,4}(?![0-9０-９]*(?:円|万|日|時|分|年|月))|[ァ-ヶー]{4,}(?:の|は|って|も)|[A-Za-zＡ-Ｚａ-ｚ]{4,}/;

// ── 型 ──
const PEOPLE_RE = /二人|2人|２人|ふたり|同棲|同居|彼女|彼氏|家族|妻|夫|旦那|嫁|子供|子ども|親|母|父|友達|友人|姉|兄|弟|妹|連れ|一緒/;
const TIME_RE = /来週|今週|再来週|明日|明後日|あさって|土日|週末|平日|[0-9０-９]{1,2}\s*日|[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}|午前|午後|[0-9０-９]{1,2}\s*時|夕方|朝|夜|行けます|いけます|伺えます|空いてます/;

// ── 話題（返事の語の組） ──
const TOPICS: Array<[string, RegExp]> = [
  ["viewing", /内覧|内見|ご案内|待ち合わせ|お日にち|日程|候補日|ご都合|[0-9０-９]{1,2}\s*時[〜~～から]/],
  ["movein", /ご入居|入居日|入居時期|お引越|引越し|引っ越し|退去予定|入居可能日/],
  ["people", /2人入居|二人入居|２人入居|ご同棲|同居|入居者|ご同行|ご一緒|お連れ/],
  ["vacancy", /募集中|募集終了|募集状況|空室|空いて(?:おり|ござい)|申込が入|お申込みが入|埋まって|ご紹介可能/],
  ["cost", /初期費用|御見積|お見積|見積書|割引|家賃|[0-9０-９,，]{4,}\s*円/],
  ["pet", /ペット/],
];
const topicsOf = (t: string) => TOPICS.filter(([, re]) => re.test(t)).map(([k]) => k);

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(arg("days", "60"));
  const nEx = Number(arg("examples", "3"));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const ctxSince = new Date(Date.now() - (days + 45) * 86400000).toISOString();
  const { buildingKeyOf, splitPropertyName } = await import("../app/lib/customer-state");
  const { isTestConversation } = await import("../app/lib/test-conversations");
  const { cutBeforeApplicationMaterial } = await import("../app/lib/test-pii-guard");
  const { maskPII } = await import("../app/lib/pii-mask");
  const { loadPropertyThreads } = await import("../app/lib/property-thread-server");
  const { staffLabelsOf } = await import("../app/lib/confirm-target-property");

  // 1) 60日に竹内さんの返事がある会話
  const tk = await pageAll<{ conversation_id: string }>((a, b) => sb.from("messages").select("conversation_id").eq("staff_writer", "takeuchi").gte("created_at", since).range(a, b));
  const convIds = [...new Set(tk.map((r) => r.conversation_id))].filter((id) => !isTestConversation(id));
  console.error(`会話 ${convIds.length}`);

  const rows: Array<Record<string, unknown>> = [];
  let scanned = 0, turnsAll = 0;
  for (const cid of convIds) {
    const [msgs, aix, sip, sp, wt, bd, ex, conv] = await Promise.all([
      pageAll<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, line_message_id, quoted_message_id, is_aix_generated, staff_writer").eq("conversation_id", cid).gte("created_at", ctxSince).order("created_at").range(a, b)),
      pageAll<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, created_at, sent_at, aix_type, property_names").eq("conversation_id", cid).gte("created_at", ctxSince).range(a, b)),
      pageAll<{ image_url: string; property_name: string | null; room_no: string | null }>((a, b) => sb.from("sent_image_properties").select("image_url, property_name, room_no").eq("conversation_id", cid).range(a, b)),
      pageAll<{ image_url: string | null; property_name: string | null; room_no: string | null }>((a, b) => sb.from("sent_properties").select("image_url, property_name, room_no").eq("conversation_id", cid).range(a, b)),
      pageAll<{ customer_turn_at: string; customer_last_at: string | null; draft_first: string | null; draft_last: string | null }>((a, b) => sb.from("line_watch_turns").select("customer_turn_at, customer_last_at, draft_first, draft_last").eq("conversation_id", cid).gte("customer_turn_at", since).range(a, b)),
      pageAll<{ created_at: string; analyzed_msg_ts: string | null; digest: Record<string, unknown> | null; suggested_action: string | null }>((a, b) => sb.from("brain_decision_logs").select("created_at, analyzed_msg_ts, digest, suggested_action").eq("conversation_id", cid).gte("created_at", since).range(a, b)),
      pageAll<{ ai_draft: string | null; sent_at: string | null; created_at: string }>((a, b) => sb.from("ai_reply_examples").select("ai_draft, sent_at, created_at").eq("conversation_id", cid).gte("created_at", since).not("ai_draft", "is", null).range(a, b)),
      sb.from("conversations").select("customer_name, call_name").eq("id", cid).maybeSingle(),
    ]);
    const names = [conv.data?.customer_name, conv.data?.call_name].filter((n) => String(n ?? "").trim().length >= 2);
    const { kept } = cutBeforeApplicationMaterial(msgs);
    const M = kept as Msg[];
    if (!M.length) continue;
    const imgLabel = new Map<string, string>();
    for (const r of [...sip, ...sp]) if (r.image_url && r.property_name && !imgLabel.has(r.image_url)) imgLabel.set(r.image_url, `${r.property_name}${r.room_no ? ` ${r.room_no}` : ""}`);

    // 物件の辞書（会話で出てきた建物）
    const dict = new Map<string, Room>();
    const addName = (n: string | null | undefined) => {
      const ref = splitPropertyName(n ?? "");
      if (!ref || ref.buildingKey.length < 3) return;
      if (/^(?:物件|お部屋|部屋|こちら|御見積|お見積)/.test(ref.building)) return;
      if (!dict.has(ref.buildingKey)) dict.set(ref.buildingKey, { key: ref.buildingKey, display: ref.building });
    };
    for (const v of imgLabel.values()) addName(v);
    for (const a of aix) for (const n of a.property_names ?? []) addName(n);
    for (const m of M) if (m.sender === "staff") for (const l of staffLabelsOf(m.text)) addName(l);
    if (!dict.size) continue;
    const rooms = [...dict.values()];
    const mention = (t: string | null | undefined): string[] => {
      const k = buildingKeyOf(t ?? "");
      return rooms.filter((r) => k.includes(r.key)).map((r) => r.key);
    };
    const msgRooms = (m: Msg): string[] => {
      const s = new Set<string>(mention(m.text));
      if (m.image_url && imgLabel.has(m.image_url)) for (const k of mention(imgLabel.get(m.image_url))) s.add(k);
      return [...s];
    };
    const aixRoomsIn = (t0: number, t1: number) => {
      const s = new Set<string>();
      for (const a of aix) { const t = ms(a.sent_at ?? a.created_at); if (t >= t0 && t <= t1) for (const n of a.property_names ?? []) for (const k of mention(n)) s.add(k); }
      return s;
    };
    const byLine = new Map(M.filter((m) => m.line_message_id).map((m) => [m.line_message_id as string, m]));

    // 2) お客様の番（続けての発言をまとめる）
    for (let i = 0; i < M.length; i++) {
      if (M[i].sender !== "customer" || (i > 0 && M[i - 1].sender === "customer")) continue;
      let j = i; while (j + 1 < M.length && M[j + 1].sender === "customer") j++;
      const turn = M.slice(i, j + 1);
      const tStart = ms(turn[0].created_at), tEnd = ms(turn.at(-1)!.created_at);
      if (tStart < ms(since)) { i = j; continue; }
      turnsAll++;
      // 返事（次のお客様の発言まで・24h）
      let k = j + 1; const reply: Msg[] = [];
      while (k < M.length && M[k].sender !== "customer" && ms(M[k].created_at) - tEnd < 86400000) { reply.push(M[k]); k++; }
      i = j;
      if (!reply.length) continue;
      const firstText = reply.find((m) => m.text && !/^\s*\[画像\]/.test(m.text));
      if (!firstText || firstText.staff_writer !== "takeuchi") continue;
      const texts = turn.filter((m) => !m.image_url && !/^\s*\[(?:画像|動画|スタンプ|ファイル)/.test(m.text ?? "")).map((m) => m.text ?? "").join("\n");
      const hasImg = turn.some((m) => !!m.image_url || /^\s*\[画像\]/.test(m.text ?? ""));
      const quoted = turn.map((m) => (m.quoted_message_id ? byLine.get(m.quoted_message_id) ?? null : null)).filter(Boolean) as Msg[];
      const quoteMissing = turn.some((m) => m.quoted_message_id && !byLine.has(m.quoted_message_id));
      scanned++;
      // 主語の抜け: 述語があり、物件を自分で言っていない
      if (!texts.trim() && !hasImg) continue;
      if (texts.length > 160) continue;
      if (!PRED_RE.test(texts)) continue;
      if (mention(texts).length || NAMED_RE.test(texts)) continue;

      // 直前のこちらの送信（前のお客様の番から今まで・72h）
      let p = i - 1; const before: Msg[] = [];
      while (p >= 0 && M[p].sender !== "customer" && tStart - ms(M[p].created_at) < 3 * 86400000) { before.unshift(M[p]); p--; }
      const prevRooms = new Set<string>(before.flatMap(msgRooms));
      if (before.length) for (const r of aixRoomsIn(ms(before[0].created_at) - 1000, tStart)) prevRooms.add(r);
      // 正解（返事が指した物件）
      const replyEnd = ms(reply.at(-1)!.created_at);
      const replySet = new Set<string>(reply.flatMap(msgRooms));
      for (const r of aixRoomsIn(tEnd, replyEnd + 60000)) replySet.add(r);
      // 返事で新しく送った物件（ピックアップの束等）は正解にしない＝番の前に出ていた物件だけ。
      //   ただしお客様が画像・URL で持ち込んだ番で、返事に新しい物件が1件だけならそれ（持ち込みの物件）
      const preRooms = new Set<string>(M.slice(0, j + 1).flatMap(msgRooms));
      for (const r of aixRoomsIn(0, tStart)) preRooms.add(r);
      let truthSet = new Set([...replySet].filter((r) => preRooms.has(r)));
      const newOnes = [...replySet].filter((r) => !preRooms.has(r));
      if (!truthSet.size && (hasImg || turn.some((m) => /https?:\/\//.test(m.text ?? ""))) && newOnes.length === 1) truthSet = new Set(newOnes);
      // 複数を指す語（2件とも・どの物件も・全部）は1件の正解にしない
      if (/[2２二]件とも|どの物件も|どれも|全部|全て|すべて|いずれも/.test(texts)) truthSet = new Set();
      const truth = truthSet.size === 1 ? [...truthSet][0] : null;
      const replyText = reply.map((m) => m.text ?? "").join("\n");
      const tTopics = topicsOf(replyText);
      const truthTopic = tTopics.length === 1 ? tTopics[0] : null;

      // 型
      const types: string[] = [];
      if (prevRooms.size >= 2) types.push("複数物件の後");
      if (hasImg) types.push("画像の後");
      if (quoted.length || quoteMissing) types.push("引用");
      if (PEOPLE_RE.test(texts)) types.push("人（同行・家族）");
      if (TIME_RE.test(texts)) types.push("時期");
      // 戻り: 正解の物件が最後に出たのが番の20通より前／3日より前
      let lastIdx = -1;
      if (truth) for (let q = i - 1; q >= 0; q--) { if (msgRooms(M[q]).includes(truth)) { lastIdx = q; break; } }
      if (truth && lastIdx < 0) for (const a of aix) { if (ms(a.sent_at ?? a.created_at) < tStart && (a.property_names ?? []).some((n) => mention(n).includes(truth))) { lastIdx = -2; } }
      const gapMsgs = lastIdx >= 0 ? j - lastIdx : null;
      const gapDays = lastIdx >= 0 ? (tStart - ms(M[lastIdx].created_at)) / 86400000 : null;
      const inWindow20 = gapMsgs != null && gapMsgs <= 20;
      if (truth && ((gapMsgs != null && gapMsgs > 20) || (gapDays != null && gapDays > 3))) types.push("前の話題に戻る");
      if (!types.length) types.push("その他（単発）");

      // ブレイン
      const brain = bd.filter((b) => b.analyzed_msg_ts && ms(b.analyzed_msg_ts) >= tStart - 1000 && ms(b.analyzed_msg_ts) <= tEnd + 1000 && ms(b.created_at) <= ms(reply[0].created_at) + 60000)
        .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0] ?? null;
      const dg = (brain?.digest ?? {}) as Record<string, unknown>;
      const bProp = mention(String(dg.prop ?? ""));
      const bQd = mention([...(Array.isArray(dg.q) ? dg.q : []), dg.dir ?? ""].join("\n"));
      const bRooms = bProp.length ? bProp : bQd;
      const bText = [dg.prop, ...(Array.isArray(dg.q) ? dg.q : []), dg.dir].filter(Boolean).join(" ｜ ");
      // 下書き
      const w = wt.find((x) => ms(x.customer_turn_at) >= tStart - 60000 && ms(x.customer_turn_at) <= tEnd + 60000);
      const pick = (x: unknown) => { const v = String(x ?? ""); return /^__\w+__$/.test(v.trim()) ? "" : v; };
      let draft = w ? pick(w.draft_last) || pick(w.draft_first) : "";
      let draftSrc = draft ? "watch" : "";
      if (!draft) {
        const e = ex.filter((x) => x.sent_at && Math.abs(ms(x.sent_at) - ms(reply[0].created_at)) < 15 * 60000 && x.ai_draft && !/^__\w+__$/.test(x.ai_draft.trim()))[0];
        if (e) { draft = e.ai_draft ?? ""; draftSrc = "examples"; }
      }
      const dRooms = mention(draft);
      const dTopics = topicsOf(draft);
      const bTopics = topicsOf(bText);
      // 同じ建物の表記ゆれ（画像の読み取りの化け LOCHAS↔LOHAS・ロジワール↔ロワジール）は同じに数える（2文字の組の重なり 0.6 以上）
      const bg = (s: string) => { const out = new Set<string>(); for (let x = 0; x < s.length - 1; x++) out.add(s.slice(x, x + 2)); return out; };
      const same = (a: string | null, b: string | null) => { if (!a || !b) return false; if (a === b) return true; const A = bg(a), B = bg(b); let n = 0; for (const x of A) if (B.has(x)) n++; return (2 * n) / (A.size + B.size || 1) >= 0.6; };
      const judge = (r: string[]) => (!truth ? null : r.length === 0 ? "指さず" : r.every((x) => same(x, truth)) ? "同じ" : r.some((x) => same(x, truth)) ? "複数（正解を含む）" : "別");
      const judgeT = (t: string[], has: boolean) => (!truthTopic || !has ? null : t.includes(truthTopic) ? "同じ" : t.length ? "別" : "指さず");

      // 決定論の候補（試案）: 引用 → 直前のこちらの送信が1件 → お客様が最後に名前を出した物件（30通） → こちらが最後に出した物件
      let cand: string | null = null, candBy = "";
      for (const q of quoted) { const r = msgRooms(q); if (r.length === 1) { cand = r[0]; candBy = "引用"; break; } }
      if (!cand && prevRooms.size === 1) { cand = [...prevRooms][0]; candBy = "直前の送信が1件"; }
      if (!cand) for (let q = i - 1; q >= Math.max(0, i - 30); q--) { if (M[q].sender === "customer") { const r = msgRooms(M[q]); if (r.length === 1) { cand = r[0]; candBy = "お客様が最後に名前を出した"; break; } } }
      if (!cand) for (let q = i - 1; q >= Math.max(0, i - 30); q--) { const r = msgRooms(M[q]); if (r.length === 1) { cand = r[0]; candBy = "こちらが最後に出した1件"; break; } if (r.length > 1) break; }

      // 台帳（今の仕組み）
      let threadTarget: string | null = null, threadBy = "";
      if (truth && !flag("no-thread")) {
        const s = await loadPropertyThreads(cid, { asOf: new Date(tEnd + 1000).toISOString() });
        const tt = s?.turnTargets.at(-1);
        if (tt) { const r = s!.rooms.find((x) => x.key === tt.roomKey); threadTarget = r ? mention(r.ref.display)[0] ?? r.ref.buildingKey : null; threadBy = tt.by; }
      }
      const disp = (key: string | null) => (key ? dict.get(key)?.display ?? key : "-");
      rows.push({
        conv: cid.slice(0, 8), at: turn[0].created_at, types, text: maskPII(one(texts || "[画像]", 80), names), hasImg, quoted: quoted.length, quoteMissing,
        quotedImg: quoted.some((q) => !!q.image_url), quotedLabel: quoted.map((q) => (q.image_url ? imgLabel.get(q.image_url) ?? "(名前なし画像)" : one(q.text ?? "", 30))).join(" / "),
        prevRooms: [...prevRooms].map(disp), truth: disp(truth), truthKey: truth, truthTopic, replyTopics: tTopics,
        reply: maskPII(one(replyText, 140), names), gapMsgs, gapDays: gapDays != null ? Math.round(gapDays * 10) / 10 : null, inWindow20,
        brainFound: !!brain, brainProp: String(dg.prop ?? ""), brainText: one(bText, 140), brainRooms: bRooms.map(disp), brainJ: brain ? judge(bRooms) : null, brainTopicJ: judgeT(bTopics, !!brain),
        draftFound: !!draft, draftSrc, draft: maskPII(one(draft, 140), names), draftRooms: dRooms.map(disp), draftJ: draft ? judge(dRooms) : null, draftTopicJ: judgeT(dTopics, !!draft),
        truthByText: truth ? reply.some((m) => !m.image_url && mention(m.text).some((x) => same(x, truth))) : null,
        truthByPlain: truth ? reply.some((m) => !m.image_url && !m.is_aix_generated && !/【[^】]{2,40}】|初期費用さらに|現地エントランスお待ち合わせ/.test(m.text ?? "") && mention(m.text).some((x) => same(x, truth))) : null,
        replyAix: reply.some((m) => !!m.is_aix_generated),
        convFull: cid, lastAt: turn.at(-1)!.created_at,
        staffAix: [...new Set(aix.filter((a) => { const t = ms(a.sent_at ?? a.created_at); return t >= tEnd && t <= replyEnd + 60000; }).map((a) => a.aix_type ?? ""))].filter(Boolean),
        staffPromise: /確認(?:させて|致し|いたし)[^\n。！!]{0,20}(?:ます|次第)|お送りさせて頂きます/.test(reply.filter((m) => !m.is_aix_generated).map((m) => m.text ?? "").join("\n")),
        wrongNames: [...new Set([...bRooms, ...dRooms].filter((x) => truth && !same(x, truth)).map(disp))],
        cand: disp(cand), candBy, candJ: truth ? (same(cand, truth) ? "同じ" : cand ? "別" : "なし") : null,
        thread: threadTarget ? disp(threadTarget) : null, threadBy, threadJ: truth ? (threadTarget ? (same(threadTarget, truth) ? "同じ" : "別") : "出ない") : null,
      });
    }
  }

  // 3) 表
  const TYPES = ["複数物件の後", "画像の後", "引用", "前の話題に戻る", "人（同行・家族）", "時期", "その他（単発）"];
  const pct = (a: number, b: number) => (b ? `${a}/${b}（${Math.round((a / b) * 100)}%）` : "-");
  console.log(`\n${days}日: お客様の番 ${turnsAll}・竹内さんが返した番 ${scanned}・主語の抜け ${rows.length}・正解の物件が決まる ${rows.filter((r) => r.truthKey).length}・正解の話題が決まる ${rows.filter((r) => r.truthTopic).length}`);
  console.log("\n■ 物件（正解が決まる番だけ）: 型 | 番 | ブレイン 同じ／別／指さず／記録なし | 下書き 同じ／別／指さず／記録なし | 台帳が出した→同じ | 20通の窓の中 | 決定論の候補 同じ");
  const line = (label: string, rs: Array<Record<string, unknown>>) => {
    const t = rs.filter((r) => r.truthKey);
    const c = (f: string, v: string | null) => t.filter((r) => r[f] === v).length;
    console.log(`${label} | ${t.length} | ${c("brainJ", "同じ")}／${c("brainJ", "別") + c("brainJ", "複数（正解を含む）")}／${c("brainJ", "指さず")}／${c("brainJ", null)} | ${c("draftJ", "同じ")}／${c("draftJ", "別") + c("draftJ", "複数（正解を含む）")}／${c("draftJ", "指さず")}（うち竹内が手打ちの文で名前を出した ${t.filter((r) => r.draftJ === "指さず" && r.truthByPlain).length}）／${c("draftJ", null)} | ${t.filter((r) => r.threadJ !== "出ない").length}→${c("threadJ", "同じ")} | ${t.filter((r) => r.inWindow20).length} | ${pct(c("candJ", "同じ"), t.length)}`);
  };
  line("全体", rows);
  for (const ty of TYPES) line(ty, rows.filter((r) => (r.types as string[]).includes(ty)));
  const BRAIN_ERA = "2026-09-13T10:00:00Z"; // digest が残り始めた時刻
  const era = rows.filter((r) => String(r.at) >= BRAIN_ERA);
  console.log(`\n■ 物件（9/13 以降＝ブレインの digest がある期間）`);
  line("全体", era);
  for (const ty of TYPES) line(ty, era.filter((r) => (r.types as string[]).includes(ty)));
  console.log("\n■ 話題（正解が決まる番だけ）: 型 | 番 | ブレイン 同じ／別／指さず | 下書き 同じ／別／指さず");
  const lineT = (label: string, rs: Array<Record<string, unknown>>) => {
    const t = rs.filter((r) => r.truthTopic);
    const c = (f: string, v: string) => t.filter((r) => r[f] === v).length;
    console.log(`${label} | ${t.length} | ${c("brainTopicJ", "同じ")}／${c("brainTopicJ", "別")}／${c("brainTopicJ", "指さず")} | ${c("draftTopicJ", "同じ")}／${c("draftTopicJ", "別")}／${c("draftTopicJ", "指さず")}`);
  };
  lineT("全体", rows);
  for (const ty of TYPES) lineT(ty, rows.filter((r) => (r.types as string[]).includes(ty)));
  console.log(`\n■ 話題（9/13 以降）`);
  lineT("全体", era);
  for (const ty of TYPES) lineT(ty, era.filter((r) => (r.types as string[]).includes(ty)));
  console.log("\n■ 決定論の候補の段ごとの当たり");
  for (const by of ["引用", "直前の送信が1件", "お客様が最後に名前を出した", "こちらが最後に出した1件", ""]) {
    const t = rows.filter((r) => r.truthKey && r.candBy === by);
    console.log(`  ${by || "（候補なし）"}: ${pct(t.filter((r) => r.candJ === "同じ").length, t.length)}`);
  }
  console.log("\n■ 引用: 引用の番 " + rows.filter((r) => (r.quoted as number) > 0 || r.quoteMissing).length + "・引用先が画像 " + rows.filter((r) => r.quotedImg).length + "・引用先が会話に無い " + rows.filter((r) => r.quoteMissing).length);

  // 4) 外れの実例（型ごと）
  for (const ty of TYPES) {
    const bad = rows.filter((r) => (r.types as string[]).includes(ty) && r.truthKey && (r.brainJ === "別" || r.draftJ === "別" || (r.draftJ === "指さず" && r.brainJ !== "同じ")));
    if (!bad.length) continue;
    console.log(`\n── 外れ: ${ty}（${bad.length}）`);
    for (const r of bad.slice(0, nEx)) {
      console.log(`#${r.conv} ${String(r.at).slice(0, 16)} 「${r.text}」 直前の送信=${(r.prevRooms as string[]).join("・") || "-"} 引用=${r.quotedLabel || "-"} 戻り=${r.gapMsgs ?? "?"}通/${r.gapDays ?? "?"}日`);
      console.log(`   正解=${r.truth}（竹内: ${r.reply}）`);
      console.log(`   ブレイン=${r.brainJ ?? "記録なし"}（${r.brainText}）`);
      console.log(`   下書き=${r.draftJ ?? "記録なし"}（${r.draft}）`);
      console.log(`   台帳=${r.thread ?? "出ない"}${r.threadBy ? `/${r.threadBy}` : ""} 候補=${r.cand}（${r.candBy || "-"}）`);
    }
  }
  // 5) 試験に足す候補（brain-exam-add.ts --add の雛形）: 正解の物件が決まり・物件が並んだ／引用／戻り／画像の番。外れた番を先に。
  //    足す前に必ず会話を読んで正解が決まる番だけ（--add は人が判断して流す。このスクリプトは書かない）
  if (flag("suggest")) {
    const hard = (r: Record<string, unknown>) => (r.types as string[]).some((t) => ["複数物件の後", "引用", "前の話題に戻る", "画像の後"].includes(t));
    const miss = (r: Record<string, unknown>) => r.brainJ === "別" || r.draftJ === "別" || (r.draftJ === "指さず" && !!r.truthByPlain);
    const cands = rows.filter((r) => r.truthKey && hard(r)).sort((a, b) => Number(miss(b)) - Number(miss(a)));
    console.log(`\n■ 試験の候補（主語の抜け・${cands.length}・外れた番が先）`);
    for (const r of cands.slice(0, Number(arg("limit", "20")))) {
      const sa = r.staffAix as string[];
      const accept = sa.length ? sa.map((a) => `AIX:${a}`).join(",") : r.staffPromise ? "2段,返信" : "返信";
      const route = sa.length ? "aix" : r.staffPromise ? "promise" : "reply";
      const q = String(r.text).replace(/"/g, "'").slice(0, 40);
      const wrong = r.wrongNames as string[];
      const ng = wrong.length ? ` --ng="${wrong.join("・")}の話として答える（お客様が指したのは${r.truth}）"` : "";
      console.log(`# ${miss(r) ? "外れ" : "当たり"} [${(r.types as string[]).join(",")}] B=${r.brainJ ?? "-"} D=${r.draftJ ?? "-"}`);
      console.log(`npx tsx --env-file=.env.local scripts/brain-exam-add.ts --add --conv=${r.convFull} --at=${r.lastAt} --type=主語の抜け --tags=${(r.types as string[])[0]} --accept=${accept} --ask="${q}|${route}|${r.truth}の事として答える（物件名を出す）"${ng} --why="直前の送信${(r.prevRooms as string[]).length}件・引用=${String(r.quotedLabel || "なし").slice(0, 30)}。竹内さんは${r.truth}として返した"`);
    }
  }
  const out = arg("json");
  if (out) { const fs = await import("node:fs"); fs.writeFileSync(out, JSON.stringify(rows, null, 1)); console.error(`→ ${out}`); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
