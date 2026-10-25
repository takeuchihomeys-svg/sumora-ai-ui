// app/lib/sent-props-text.ts
// ブレインに注入する【すでに送付済みの物件】の組み立て（純関数・brain-core.ts から切り出し）。
//
// 2026-09-24 竹内「これで送ったのとかも判断できる。どれ物件ピックアップで送ったか物件オススメで送ったかもわかる」:
//   ・お客様に送った行 → 画像の行 → グループに共有のみの行 の順に並べる（物件名＋号室の重複除けがこの順で効くので、送った事実が勝つ）
//   ・見出しの件数はお客様に送った件数。共有のみは同じブロックの下に「▼グループに共有のみ（お客様には未送付）」で並べる
//   ・「絶対に再提案しない」は両方に効く文のまま（抑止の範囲は変えない）
//   ・🌟オススメ・📤ピックアップの印は channel から（sent_properties の channel と sent_image_properties の source の両方）
import { jstMD } from "@/app/lib/jst-date";
import { rowChannel } from "@/app/lib/sent-delivery";

export type SentProp = {
  property_name: string; room_no: string; sent_at: string; rent: number | null;
  recruitment_status: string | null; applicant_rank: number | null; customer_reaction: string | null;
  /** 画像から読み取って記録した物の経路（sent_image_properties.source） */
  sent_via?: string | null;
  /** 送った経路（pickup / recommendation …） */
  channel?: string | null;
  source?: string | null;
  /** グループに共有しただけ（お客様には未送付） */
  shared_only?: boolean;
  /** 2026-10-24: この物件で送った画像の URL（同じ物件の行をまとめる・資料の読み取り image_details を引く鍵） */
  image_urls?: string[];
  /** 2026-10-24: 送った資料の読み取りの現況・退去予定・入居可能日・内覧可能日（BRAIN_SENT_SHEET_VACANCY=on の時だけ brain-core が入れる） */
  sheet_vacancy?: string | null;
};

type CustomerRow = { property_name: string | null; room_no: string | null; sent_at: string | null; rent?: number | null; recruitment_status?: string | null; applicant_rank?: number | null; customer_reaction?: string | null; source?: string | null; channel?: string | null; image_url?: string | null };
type ImageRow = { property_name: string | null; room_no: string | null; created_at: string | null; source: string | null; channel?: string | null };
type SharedRow = { property_name: string | null; room_no: string | null; sent_at: string | null; rent?: number | null };

const RECRUIT_LABEL: Record<string, string> = { open: "募集中", move_out_planned: "退去予定", occupied: "入居中", closed: "募集終了" };
const REACTION_LABEL: Record<string, string> = { interested: "興味あり", rejected: "見送り", no_response: "反応なし" };

// ── 2026-10-24 送った資料の現況（q053 型・P0「材料が届いていない」） ─────────────────────────────
// 送った資料の画像の読み取り（image_details.lines）には「現況: 退去予定」「退去予定: 9/30」「入居可能日: 相談」が入っているのに
//   （直近60日・お客様に送った画像 1,933枚のうち現況の行 1,206枚）、ブレインに渡る送った物件の行は sent_properties.recruitment_status だけで
//   状態が入っていたのは 512枚（退去予定 106枚 対 読み取りでは 241枚）。読み取りに現況が有るのに台帳が空の行 857・送った後3日以内に
//   お客様が内覧・入居の時期に触れた番 149（42会話）。→ 読み取りの行（sheet-vacancy.alignVacancyLines で欄どおりに整えた物）をそのまま載せる。
//   字は変えない（決めつけない）。資料は送った時点の物＝日付を付ける。戻す: BRAIN_SENT_SHEET_VACANCY（既定 off）
export function sentSheetVacancyOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BRAIN_SENT_SHEET_VACANCY ?? "").trim().toLowerCase() === "on";
}
const SHEET_VAC_LABELS = ["現況", "退去予定", "入居可能日", "内覧可能日"] as const;
/** 読み取りの行から現況・退去予定・入居可能日・内覧可能日を拾って1行に（見出しごとに最初の1つ・各30字まで）。無ければ null */
export function sheetVacancyNote(lines: unknown): string | null {
  if (!Array.isArray(lines)) return null;
  const got = new Map<string, string>();
  for (const raw of lines) {
    const l = String(raw ?? "").replace(/\s+/g, " ").trim();
    const m = l.match(/^(現況|退去予定|入居可能日|内覧可能日)\s*[:：]\s*(.+)$/);
    if (!m || got.has(m[1])) continue;
    const v = m[2].trim().slice(0, 30);
    if (v) got.set(m[1], v);
  }
  if (!got.size) return null;
  return SHEET_VAC_LABELS.filter((k) => got.has(k)).map((k) => `${k} ${got.get(k)}`).join("・");
}
/** 送った物件ごとに、その物件で送った画像の読み取りから現況の1行を付ける（同じ物件の画像が複数なら、現況の行がある方）。付けた数を返す */
export function attachSheetVacancy(props: SentProp[], linesByUrl: ReadonlyMap<string, unknown>): number {
  let n = 0;
  for (const p of props) {
    if (p.shared_only) continue;
    for (const u of p.image_urls ?? []) {
      const note = sheetVacancyNote(linesByUrl.get(u));
      if (note) { p.sheet_vacancy = note; n++; break; }
    }
  }
  return n;
}

export function buildSentProps(input: { customerRows: CustomerRow[]; imageRows: ImageRow[]; sharedRows: SharedRow[] }): SentProp[] {
  const seen = new Set<string>();
  const out: SentProp[] = [];
  const add = (p: SentProp) => {
    const name = (p.property_name ?? "").trim();
    if (!name) return;
    const key = `${name}|${(p.room_no ?? "").trim()}`;
    if (seen.has(key)) {
      // 2026-10-24: 同じ物件の別の画像（資料と見積書など）の URL はまとめておく（資料の読み取りを引く鍵）
      const ex = out.find((o) => `${o.property_name}|${o.room_no}` === key);
      for (const u of p.image_urls ?? []) if (ex && !(ex.image_urls ?? []).includes(u)) ex.image_urls = [...(ex.image_urls ?? []), u];
      return;
    }
    seen.add(key);
    out.push({ ...p, property_name: name, room_no: (p.room_no ?? "").trim() });
  };
  // 2026-09-20: property_customer_id と conversation_id の両方で引くので、同じ物件が2行来ることがある（先頭＝新しい方を残す）
  for (const p of input.customerRows) {
    add({
      property_name: p.property_name ?? "", room_no: p.room_no ?? "", sent_at: p.sent_at ?? "", rent: p.rent ?? null,
      recruitment_status: p.recruitment_status ?? null, applicant_rank: p.applicant_rank ?? null, customer_reaction: p.customer_reaction ?? null,
      source: p.source ?? null, channel: rowChannel({ channel: p.channel ?? null, source: p.source ?? null }),
      ...(p.image_url ? { image_urls: [p.image_url] } : {}),
    });
  }
  // 2026-09-20 竹内（物件把握の監査）: 画像だけで送った物件（送信時の読み取り）を足す。既に sent_properties にある物件は重複させない
  for (const p of input.imageRows) {
    add({
      property_name: p.property_name ?? "", room_no: p.room_no ?? "", sent_at: p.created_at ?? "", rent: null,
      recruitment_status: null, applicant_rank: null, customer_reaction: null,
      sent_via: p.source ?? null, channel: rowChannel({ channel: p.channel ?? null, source: p.source }),
    });
  }
  // 共有のみ（グループに出しただけ）。再提案の抑止は効かせたまま、見出しを分けて出す
  //   共有の行は号室が殆ど無い（0.1%）ので、号室なしの共有の行は同じ建物をお客様に送っていれば出さない
  //   （「YUMAテスト荘 101 を送付」と「YUMAテスト荘 共有のみ・未送付」が並んで食い違わないように）
  const sentNames = new Set(out.map((p) => p.property_name));
  for (const p of input.sharedRows) {
    if (!(p.room_no ?? "").trim() && sentNames.has((p.property_name ?? "").trim())) continue;
    add({
      property_name: p.property_name ?? "", room_no: p.room_no ?? "", sent_at: p.sent_at ?? "", rent: p.rent ?? null,
      recruitment_status: null, applicant_rank: null, customer_reaction: null, channel: "extension_group", shared_only: true,
    });
  }
  return out;
}

export function buildSentPropsText(sentProps: SentProp[]): string {
  if (sentProps.length === 0) return "";
  // 2026-09-20 竹内「どの物件をお客さんにたいしてオススメしたのか分かるように」→ 内覧・見積の相手を取り違えない
  const recommendedProps = sentProps.filter((p) => !p.shared_only && p.channel === "recommendation");
  const deliveredProps = sentProps.filter((p) => !p.shared_only);
  const sharedOnlyProps = sentProps.filter((p) => p.shared_only);
  const line = (p: SentProp) => {
    const facts = [
      p.rent != null ? `家賃${p.rent.toLocaleString()}円` : "",
      p.recruitment_status ? `募集状況:${RECRUIT_LABEL[p.recruitment_status] ?? p.recruitment_status}` : "",
      p.applicant_rank != null ? `${p.applicant_rank}番手` : "",
      p.customer_reaction ? `顧客反応:${REACTION_LABEL[p.customer_reaction] ?? p.customer_reaction}` : "",
      p.sheet_vacancy ? `送った資料（${jstMD(p.sent_at)}時点）の${p.sheet_vacancy}` : "",
    ].filter(Boolean).join("・");
    if (p.shared_only) return `- ${p.property_name} ${p.room_no}（${jstMD(p.sent_at)} グループに共有のみ・お客様には未送付${facts ? `・${facts}` : ""}）`;
    const via = p.channel === "recommendation" ? "・🌟オススメで送付" : p.channel === "pickup" ? "・📤ピックアップで送付" : "";
    return `- ${p.property_name} ${p.room_no}（${jstMD(p.sent_at)}送付${facts ? `・${facts}` : ""}${via}）`;
  };
  const sharedBlock = sharedOnlyProps.length > 0
    ? `${deliveredProps.length > 0 ? "\n" : ""}▼グループに共有のみ（お客様には未送付・再提案は避ける）\n${sharedOnlyProps.map(line).join("\n")}`
    : "";
  // 2026-09-26 段3（切り替え）: 旧「内覧・見積・申込の話はこのお部屋が相手になる（別の物件にすり替えない）」は、
  //   お客様が自分で見つけた物件（SUUMO の URL・画像）や、後から名前を出した別のお部屋の内覧・見積の話まで、推した物件に寄せる入口になり得た
  //   （設計知見「1つの物件へのとらわれは…」の (c)・害は小）。お客様がどのお部屋か言っていない時だけの既定にする
  const recNote = recommendedProps.length > 0
    ? `\n※このうち **${recommendedProps.map((p) => `${p.property_name} ${p.room_no}`.trim()).join("・")}** は AIX【物件オススメ】で推した物件。内覧・見積・申込の話でお客様がどのお部屋か言っていない時は、このお部屋が相手の第一候補（お客様が名前・URL・画像で別のお部屋を指している時は、そのお部屋が相手）。`
    : "";
  // 2026-10-24: 資料の現況を載せた時だけ読み方を1行（字は送った時点の資料・今の空きはスタッフの確認が正）
  const sheetNote = deliveredProps.some((p) => p.sheet_vacancy)
    ? `\n※「送った資料の現況」は送った時点の資料の字（今の空きはスタッフの確認が正）。空室＝内覧の日程をすぐ組める／退去予定＝退去予定日・入居可能日が書いてあればその日以降、日付が無い・相談ならいつから見られるかはスタッフが確かめる事。`
    : "";
  return `\n【すでに送付済みの物件（${deliveredProps.length}件）】\n${deliveredProps.map(line).join("\n")}${sharedBlock}${recNote}${sheetNote}\n※上記の物件は絶対に再提案しないこと（顧客が明示的に再リクエストした場合を除く。例外: 顧客が申込→落選した物件と同一マンションの別号室が新規募集された場合は、最優先で提案し申込訴求すること。申込経験のある建物は建物の印象・共用部・立地を把握済みのため内覧スキップ可能）。property_send・property_recommendation の候補から必ず除外すること。`;
}
