// app/lib/conductor-our-side.ts — 入口の統括に渡す「こちら側の状態」の短い1塊（純関数・DB/LLM なし）
//
// 2026-11-11 作業員4（弱い所 565「AIX の種類・順番の読み違い」13番・568「スタッフだけが結果を持つ番を返信にする」13番・統括役の指示）:
//   根は、統括が約束の帳面（確認の約束 → 結果 → 見積書の順・確認中 → スタッフの手元に結果あり）とピッカーの意味を持っていない事。
//   竹内さんの決定（11/11・KB P1 bfb1d47d）「こちら側の細かい所（何を送ったか・何を約束したか・AIX で何を送ったか）にも注目して読む」と同じ向き。
//   竹内さんの番 1,123（conductor_turn_vectors v2）を、こちら側の状態ごとに数えた（11/11）:
//     見積書の約束が開いている → AIX【見積書送る】13/19／直前に内覧の案内の AIX（了承の一言）→ AIX【待ち合わせ場所】9/12／
//     確認の約束が開いている＋お客様の一言 → 返信 23/30／約束なし＋空きの問い → AIX【物件確認した】4/11・返信 4/11
//   ＝同じお客様の一言でも、こちら側の状態で竹内さんの一手が変わる。状態をそのまま渡し、読むのは統括（決めるのはブレイン・P0 9eb6aa9c）。
//   切替: CONDUCTOR_OUR_SIDE=on（既定 off）。テスト: app/lib/__tests__/conductor-our-side.test.ts

type Env = Record<string, string | undefined>;
export const conductorOurSideOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_OUR_SIDE ?? "").trim().toLowerCase() === "on";
// 2026-11-11 統括役（入口では読みが変わらなかった・弱い19番 7→8）: 同じ塊をブレイン本体の材料と AIX の統括（種類を決める所）に渡す
// 2026-11-12 統括役の決め（8問×2で合格 4→5・確かな悪化0・守り同じ）: 既定 on。止める =off
// 2026-11-12 朝 統括役: 既定 off に戻す。on の後に q057（退去予定の部屋の「内見はできない感じ？」）が 0/4（本質が内覧調整の AIX に寄る 4/4）・off で 1/3（寄り 0/3）。入れる =on
export const ourSideBrainOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_OUR_SIDE_BRAIN ?? "").trim().toLowerCase() === "on";

export type OurSideMsg = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null };
export type OurSideAix = { aix_type: string; check_pattern?: string | null; created_at: string; sent_at?: string | null; property_names?: string[] | null; prop_statuses?: string[] | null; estimate_sent?: boolean | null };

const AIX_JA: Record<string, string> = {
  property_send: "物件送付（束）", property_recommendation: "物件オススメ（1件）", property_check_result: "物件確認した（確かめた結果を送る＝空き・募集・入居日・室内写真／管理会社に確かめた条件・設備・交渉の結果は mgmt_* のピッカー）",
  acknowledge_check: "確認します（これから確かめる・交渉する約束を AIX で送る）", estimate_sheet: "見積書送る", viewing_invite: "内覧調整（候補日）", meeting_place: "待ち合わせ場所（内覧の確定）",
  application_push: "申込へ", phone_call: "電話", guarantor_info: "保証会社", condition_hearing: "条件ヒアリング", zenryoku_support: "全力サポート", cost_explain: "初期費用を説明",
};
const PICK_JA: Record<string, string> = {
  available: "募集中", unavailable: "募集終了", vacating: "退去予定", move_out_planned: "退去予定", alternative: "代わりの部屋が募集中", taken: "申込あり", second_position: "2番手", exclusive: "専任",
};
const MGMT_JA: Record<string, string> = { availability: "募集状況", initial_cost: "初期費用の交渉", proxy: "代理契約", guarantor: "保証会社", parking: "駐車場", pet: "ペット", equipment: "設備", move_in: "入居日" };
const pickJa = (p: string | null | undefined) => (!p ? "" : PICK_JA[p] ?? (p.startsWith("mgmt_") ? `管理会社に確かめた結果（${MGMT_JA[p.slice(5)] ?? p.slice(5)}）` : p));

/** 約束の種類（決まった計算の網・こちらの文の言い方で分ける） */
export function promiseKindOf(t: string): "見積" | "確認" | "探す" | "内覧" | "他" {
  if (/見積/.test(t)) return "見積";
  if (/内覧|ご案内|日程|候補/.test(t)) return "内覧";
  if (/ピックアップ|お探し|探させ|新着|お送りさせて頂きます/.test(t) && !/募集状況|空き状況/.test(t)) return "探す";
  if (/募集状況|空き|空室|状況|確認(させて|致し|いたし)|確認出来次第|確認でき次第|管理会社/.test(t)) return "確認";
  return "他";
}
const PROMISE_RE = /(?:確認|お送り|ピックアップ|ご連絡|交渉|調整|作成|手配|お調べ|探させ|お探し).{0,20}(?:させて頂きます|させていただきます|致します|いたします)|次第/;
const FULFIL = new Set(["property_send", "property_recommendation", "property_check_result", "acknowledge_check", "estimate_sheet", "meeting_place", "viewing_invite"]);

const ago = (nowMs: number, iso: string) => {
  const m = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}分前` : m < 48 * 60 ? `${Math.round(m / 60)}時間前` : `${Math.round(m / 1440)}日前`;
};

/**
 * 確かめ済みの事実（純関数・決まった計算の網・2026-11-11 作業員4・弱い所 575）。
 *   竹内さんの 60日: 管理会社等に確かめた結果を伝えた文 62通のうち AIX の文 48・AIX でない返信 14（募集状況6・条件6・交渉2）。
 *   AIX の入力（ピッカー）には「募集中か」しか残らず、「11月中旬入居」「クリーニング必須」「代理契約可能」「2番手」等の中身は文の中だけ＝
 *   帳面（customer-fact-ledger）にも無い。こちらの文（AIX でも返信でも）から「確認させて頂きましたところ／管理会社確認しましたところ／交渉させて頂きましたが」の
 *   1文を拾い、①募集状況 ②条件 ③交渉 に分けて渡す（読むのはブレイン）。30日・新しい順に5つまで
 */
const RESULT_RE = /(確認|交渉)(させて頂き|させていただき|致し|いたし|し)ました(ところ|が)|管理会社(様)?(に|へ)?(確認|交渉|問い合わせ)[^。！!\n]{0,20}(ところ|結果)/;
export type CheckedFact = { kind: "①募集状況" | "②条件" | "③交渉"; gist: string; at: string };
export function checkedFacts(o: { msgs: ReadonlyArray<OurSideMsg>; nowMs: number; days?: number; max?: number }): CheckedFact[] {
  const out: CheckedFact[] = [];
  const minT = o.nowMs - (o.days ?? 30) * 86_400_000;
  for (const m of [...o.msgs].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (m.sender === "customer" || Date.parse(m.created_at) > o.nowMs || Date.parse(m.created_at) < minT) continue;
    const text = String(m.text ?? "");
    if (!RESULT_RE.test(text)) continue;
    const sents = text.replace(/\s+/g, " ").split(/(?<=[！!。])\s*/u);
    const i = sents.findIndex((s) => RESULT_RE.test(s));
    const gist = [sents[i], /ところ\s*$|が\s*$/.test(sents[i] ?? "") ? sents[i + 1] : ""].filter(Boolean).join("").slice(0, 80);
    const kind: CheckedFact["kind"] = /交渉|値下げ|割引|フリーレント|免除|外す|下げ/.test(gist) ? "③交渉" : /募集|空|申込(が|み)?(入|はい)|満室|終了|埋ま|番手/.test(gist) ? "①募集状況" : "②条件";
    out.push({ kind, gist, at: m.created_at });
    if (out.length >= (o.max ?? 5)) break;
  }
  return out;
}

/** 退去予定の部屋（純関数）: AIX の記録の物件ごとの状態（vacating・move_out_planned）と、こちらの文の「〇〇 … 退去予定」（30日）。最大3つ */
export function vacatingRoomsOf(o: { msgs: ReadonlyArray<OurSideMsg>; aix: ReadonlyArray<OurSideAix>; nowMs: number }): string[] {
  const out: string[] = [];
  const minT = o.nowMs - 30 * 86_400_000;
  for (const a of o.aix) {
    const t = Date.parse(a.sent_at ?? a.created_at);
    if (t < minT || t > o.nowMs) continue;
    (a.prop_statuses ?? []).forEach((st, i) => { const n = (a.property_names ?? [])[i]; if (n && (st === "vacating" || st === "move_out_planned") && !out.includes(n)) out.push(n); });
  }
  for (const m of o.msgs) {
    if (m.sender === "customer" || Date.parse(m.created_at) > o.nowMs || Date.parse(m.created_at) < minT) continue;
    for (const line of String(m.text ?? "").split(/\n+/)) {
      if (!/退去予定/.test(line)) continue;
      const gist = line.replace(/\s+/g, " ").trim().slice(0, 40);
      if (gist && !out.some((x) => gist.includes(x) || x.includes(gist))) out.push(gist);
    }
  }
  return out.slice(0, 3);
}
/**
 * こちら側の状態の1塊（無ければ ""）。msgs は今の番より前の通（順は問わない）、aix は AIX の記録（順は問わない）。
 *   ① 開いている約束（こちらの最後の約束の文の後に、果たす AIX がまだ無い）: 種類・その文の要点・いつ
 *   ② 直前の AIX（種類の意味・ピッカーの値・物件名2件まで・見積書の同封・いつ）
 *   ③ 送った物件（束／1件の回数・最後はいつ）
 */
/** 確かめ済みの事実の欄（弱い所 575）は別のスイッチ: OUR_SIDE_CHECKED=on（既定 off）。塊そのもの（CONDUCTOR_OUR_SIDE_BRAIN）の測りと混ぜない */
export const ourSideCheckedOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.OUR_SIDE_CHECKED ?? "").trim().toLowerCase() === "on";
export function ourSideBlock(o: { msgs: ReadonlyArray<OurSideMsg>; aix: ReadonlyArray<OurSideAix>; nowMs: number; withChecked?: boolean }): string {
  const msgs = [...o.msgs].filter((m) => Date.parse(m.created_at) <= o.nowMs).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const aix = [...o.aix].filter((a) => Date.parse(a.sent_at ?? a.created_at) <= o.nowMs).sort((a, b) => (a.sent_at ?? a.created_at).localeCompare(b.sent_at ?? b.created_at));
  const lines: string[] = [];
  // ① 開いている約束
  let promise: { text: string; at: string } | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.sender === "customer" || m.is_aix_generated) continue;
    const s = (m.text ?? "").split(/\n+|(?<=[！!。])/u).find((x) => PROMISE_RE.test(x));
    if (s) { promise = { text: s.replace(/\s+/g, " ").trim().slice(0, 50), at: m.created_at }; break; }
  }
  if (promise && aix.some((a) => FULFIL.has(a.aix_type) && (a.sent_at ?? a.created_at) > promise!.at)) promise = null; // 後で AIX で果たした
  lines.push(promise ? `・開いている約束: ${promiseKindOf(promise.text)}の約束「${promise.text}」（${ago(o.nowMs, promise.at)}・結果はまだ送っていない）` : "・開いている約束: なし");
  // ② 直前の AIX
  const last = aix[aix.length - 1];
  if (last) {
    // 11/12: 物件ごとの状態（prop_statuses）があれば名前に付ける（退去予定を「募集中」だけにしない・q057）
    const names = (last.property_names ?? []).slice(0, 3).map((n, i) => { const st = (last.prop_statuses ?? [])[i]; return n ? `${n}${st && PICK_JA[st] ? `＝${PICK_JA[st]}` : ""}` : ""; }).filter(Boolean).slice(0, 2).join("・");
    const pk = pickJa(last.check_pattern);
    lines.push(`・直前の AIX: ${AIX_JA[last.aix_type] ?? last.aix_type}${pk ? `＝${pk}` : ""}${names ? `（${names}）` : ""}${last.estimate_sent ? "・御見積書を同封" : ""}（${ago(o.nowMs, last.sent_at ?? last.created_at)}）`);
  } else lines.push("・直前の AIX: なし");
  // ③ 送った物件
  const sends = aix.filter((a) => a.aix_type === "property_send"), recs = aix.filter((a) => a.aix_type === "property_recommendation");
  const lastSend = [...sends, ...recs].sort((a, b) => (a.sent_at ?? a.created_at).localeCompare(b.sent_at ?? b.created_at)).pop();
  lines.push(sends.length || recs.length ? `・送った物件: 束 ${sends.length}回・1件のオススメ ${recs.length}回（最後 ${ago(o.nowMs, lastSend!.sent_at ?? lastSend!.created_at)}）` : "・送った物件: まだ無い");
  // ⑤ 退去予定の部屋（11/12 作業員7 の切り分け・q057: 塊が「募集中」だけを見せ、退去予定＝室内を内覧できない部屋に内覧調整の AIX を勧める読みになっていた）
  const vacating = vacatingRoomsOf({ msgs, aix, nowMs: o.nowMs });
  if (vacating.length) lines.push(`・退去予定の部屋（室内の内覧は退去後）: ${vacating.join("・")}`);
  // ④ 確かめ済みの事実（弱い所 575）
  const checked = (o.withChecked ?? ourSideCheckedOn()) ? checkedFacts({ msgs, nowMs: o.nowMs }) : [];
  if (checked.length) lines.push(`・確かめ済みの事実（こちらが管理会社等に確かめて伝えた事・同じ確認の約束を繰り返さない）:\n${checked.map((f) => `  - ${f.kind}「${f.gist}」（${ago(o.nowMs, f.at)}）`).join("\n")}`);
  return [
    "【こちら側の状態（11/11・読むのは統括）】",
    ...lines,
    "（読み方: 物件確認した＝確かめた結果を送る AIX（物件の空き・募集・入居日の結果も、管理会社に確かめた設備・条件・交渉の結果＝mgmt_* のピッカーも、この AIX）、確認します＝これから確かめる・交渉する約束を AIX で送る、見積書送る＝費用（費用を知りたいだけは見積書・管理会社との初期費用の交渉は物件確認した mgmt_initial_cost）。約束が開いている番は、その約束の続き（確認→結果→見積の順）か、新しい依頼かを先に分ける。スタッフが自分で確かめて結果を送れる事（空き・費用・内覧の日時が決まる番＝内覧調整・待ち合わせ）は、約束の返信を挟まず AIX で結果を送る番もある。ただし退去予定の部屋は室内を内覧できない＝「内見できるか」の問いに内覧調整の AIX を勧めず、退去後の内覧開始・外観や共用部の確認・先に申込で押さえられる事を返信で案内する（竹内さんの形）。お客様の言葉だけでなく、この状態と合わせて読む）",
  ].join("\n");
}

// ─── 道が決まった後の文の材料だけへ（2026-11-12 統括役の決め・作業員7・14 と同じ型の教訓） ───────────────────
//   こちら側の状態・退去予定・確かめ済みの事実・入口の読みをブレインの判断の材料に足すと、判断の道が引っ張られた（q057 内覧調整・q069 確認の AIX）。
//   KB「次の一手を進める類の欄を足すと判断の道が引っ張られる」。→ ブレインには渡さず、道が決まった後の文の統括（compose-sentence-plan の
//   受け渡しの表）と AIX の文（aix-second-brain-plan）だけに渡す。ブレインの meta に our_side_note（文の材料・記録）として残すだけ。
//   切替: OUR_SIDE_TO_COMPOSE=on（既定 off）。道（返信か AIX か）は off と同じになるはず（変わったら配線の誤り）
export const ourSideToComposeOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.OUR_SIDE_TO_COMPOSE ?? "").trim().toLowerCase() === "on";
/** 文の材料の短い塊（読み方の長い行は外し、状態の行だけ・900字まで） */
export function ourSideComposeNote(o: { msgs: ReadonlyArray<OurSideMsg>; aix: ReadonlyArray<OurSideAix>; nowMs: number; intakeLine?: string | null }): string {
  const block = ourSideBlock({ msgs: o.msgs, aix: o.aix, nowMs: o.nowMs, withChecked: true });
  const lines = block.split("\n").filter((l) => l.startsWith("・") || l.startsWith("  - "));
  const vac = vacatingRoomsOf({ msgs: o.msgs, aix: o.aix, nowMs: o.nowMs });
  const tail = vac.length ? ["・退去予定の部屋は室内を今は内覧できない（退去後に内覧・外観や共用部は確認できる・先に申込で押さえられる）"] : [];
  const il = (o.intakeLine ?? "").replace(/^【[^】]*】/, "").trim();
  return [...lines, ...tail, ...(il ? [`・入口の統括の読み: ${il.slice(0, 160)}`] : [])].join("\n").slice(0, 900);
}

// ─── スタッフの送信の後の入口の読み直し（2026-11-12 作業員4・meeting-gap:conductor-intake-staff-entry・統括役の決め 候補B） ──────────
//   入口の統括はお客様の番でしか動かず、スタッフの送信・AIX・電話の後に読み直さない。送信の口には触らず、次のお客様の番の入口の前に
//   「前のお客様の番の後にこちらがした事」（AIX の種類とピッカー・文の約束・前の入口のやる事が果たされたか）をその場で作り、入口の「前の番」の行に足す。
//   LLM なし・費用0。切替: CONDUCTOR_INTAKE_STAFF_REFRESH=on（既定 off）
export const intakeStaffRefreshOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_INTAKE_STAFF_REFRESH ?? "").trim().toLowerCase() === "on";
/**
 * 前のお客様の番（今の番の前のお客様の塊）より後で、今の番より前のこちらの動き。prevTodos は前の番の入口の統括のやる事（無ければ空）。
 *   今の番より後の通・AIX は見ない。何も無ければ ""
 */
export function staffSinceLine(o: { msgs: ReadonlyArray<OurSideMsg>; aix: ReadonlyArray<OurSideAix>; nowMs: number; prevTodos?: ReadonlyArray<{ kind?: string; what?: string }> | null }): string {
  const msgs = [...o.msgs].filter((m) => Date.parse(m.created_at) < o.nowMs).sort((a, b) => a.created_at.localeCompare(b.created_at));
  // 今の番のお客様の塊の前の、最後のお客様の通（＝前の番）
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].sender === "customer") i--; // 今の番の塊（今より前に来ていた分）を飛ばす
  let j = i; while (j >= 0 && msgs[j].sender !== "customer") j--;
  if (j < 0 || i < 0 || i === j) return "";
  const sinceIso = msgs[j].created_at, untilIso = msgs[i].created_at;
  const staff = msgs.slice(j + 1, i + 1).filter((m) => m.sender !== "customer");
  const ax = o.aix.filter((a) => { const t = a.sent_at ?? a.created_at; return t > sinceIso && Date.parse(t) <= Date.parse(untilIso) + 3 * 60_000; });
  const parts: string[] = [];
  for (const a of ax.slice(0, 3)) parts.push(`AIX ${AIX_JA[a.aix_type] ?? a.aix_type}${a.check_pattern ? `＝${pickJa(a.check_pattern)}` : ""}`);
  const promise = staff.filter((m) => !m.is_aix_generated).map((m) => (m.text ?? "").split(/\n+|(?<=[！!。])/u).find((x) => PROMISE_RE.test(x))).find(Boolean);
  if (promise) parts.push(`文で約束「${promise.replace(/\s+/g, " ").trim().slice(0, 40)}」`);
  const plain = staff.filter((m) => !m.is_aix_generated).length;
  if (!parts.length && plain) parts.push(`返信 ${plain}通`);
  if (!parts.length) return "";
  const todo = (o.prevTodos ?? []).find((t) => t.kind === "aix" || t.kind === "promise" || t.kind === "check");
  const done = todo ? (todo.kind === "aix" ? ax.length > 0 : !!promise || ax.length > 0) : null;
  return `前のお客様の番の後にこちらがした事: ${parts.join("・")}${todo ? `（前の読みのやる事「${String(todo.what ?? "").slice(0, 24)}」は${done ? "果たした" : "まだ"}）` : ""}`;
}
