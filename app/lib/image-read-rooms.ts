// app/lib/image-read-rooms.ts — 画像の読みの部屋ごとの帖数（IMAGE_READ_ROOMS の rooms）を、決まった形に並べて物件の事実の欄に入れる（純関数・LLM なし・DB なし）
//
// 2026-11-21 作業員L（台帳 #427 の続き・統括役の頼み「LLM を使わない所まで」）: 読み（property-image-read.roomsOf）は名前と帖数の並びを返すだけで、
//   並べ方・名前のそろえ方・物件の事実の欄（リビングの帖数・居室の一番広い帖数・居室の数・ブレインへの1行）が決まっていなかった。
//   名前の種類は room-jo の roomNameKind と同じ（洋・和・LDK・DK・K・S）。洋室の帖数（居室の一番広い帖数）は room-jo の roomJoFromImageRooms と同じ計算＝希望の判定（judgeRoomJo）にそのまま使える。
// 決まり: 並べ方は「リビング（LDK→LD→DK）→ 居室（広い順）→ K → S」。同じ名前・同じ帖数が2回読まれた時は1つに（読みの重ね）。
//   帖数は 0.1 帖に丸める。間取り（1LDK 等）と居室の数が食い違う時は「部屋の数が間取りと合わない」の印（言い切らない材料）。
// 切替 IMAGE_ROOMS_TO_FACTS: 既定 off（facts.rooms_facts を作らない＝今と同じ）。読みの方（IMAGE_READ_ROOMS）は別のスイッチ。
import { roomNameKind, roomJoFromImageRooms, type RoomJoItemKind } from "./room-jo";

type Env = Record<string, string | undefined>;
export function imageRoomsToFactsOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.IMAGE_ROOMS_TO_FACTS ?? "").trim().toLowerCase() === "on";
}

export type ReadRoom = { name: string; jo: number };
export type RoomsFacts = {
  /** 並べた部屋（名前は読んだまま・帖数は 0.1 丸め） */
  rooms: ReadRoom[];
  /** リビング（LDK・LD・DK）の一番広い帖数 */
  living_jo: number | null;
  /** 居室（洋・和・寝室）の一番広い帖数（room-jo の洋室の帖数と同じ計算） */
  bedroom_max_jo: number | null;
  /** 居室の数 */
  bedroom_count: number;
  /** 間取りの居室の数と読んだ居室の数が合わない（例 2LDK なのに居室1つ） */
  count_mismatch: boolean;
  /** ブレイン・文への1行（例 "LDK10.5帖・洋室6帖・洋室5帖"） */
  label: string;
};

const LIVING: ReadonlySet<RoomJoItemKind> = new Set<RoomJoItemKind>(["LDK", "DK"]);
const BEDROOM: ReadonlySet<RoomJoItemKind> = new Set<RoomJoItemKind>(["洋", "和"]);
const r1 = (n: number) => Math.round(n * 10) / 10;
const livingRank = (name: string) => (/LDK/i.test(name) ? 0 : /LD/i.test(name) ? 1 : 2);

/** 並べ方: リビング（LDK→LD→DK）→ 居室（広い順）→ K → S・他。同じ名前・同じ帖数は1つに */
export function orderRooms(rooms: ReadonlyArray<{ name?: string | null; jo?: number | null }> | null | undefined): ReadRoom[] {
  const seen = new Set<string>();
  const list: Array<ReadRoom & { kind: RoomJoItemKind }> = [];
  for (const r of rooms ?? []) {
    const name = String(r?.name ?? "").normalize("NFKC").trim();
    const jo = Number(r?.jo);
    if (!name || !Number.isFinite(jo) || jo <= 0) continue;
    const k = `${name}|${r1(jo)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ name, jo: r1(jo), kind: roomNameKind(name) });
  }
  const group = (x: { kind: RoomJoItemKind }) => (LIVING.has(x.kind) ? 0 : BEDROOM.has(x.kind) ? 1 : x.kind === "K" ? 2 : 3);
  return list
    .sort((a, b) => group(a) - group(b) || (group(a) === 0 ? livingRank(a.name) - livingRank(b.name) : 0) || b.jo - a.jo)
    .map(({ name, jo }) => ({ name, jo }));
}

/** 間取りの居室の数（1R・1K・1DK・1LDK＝1・2LDK＝2…）。読めなければ null */
export function bedroomsOfMadori(madori: string | null | undefined): number | null {
  const m = String(madori ?? "").normalize("NFKC").match(/^(\d)\s*(?:S?LDK|S?DK|S?K|R)/i);
  return m ? Number(m[1]) : null;
}

/** 物件の事実の欄（部屋が読めなければ null） */
export function roomsFactsOf(rooms: ReadonlyArray<{ name?: string | null; jo?: number | null }> | null | undefined, madori?: string | null): RoomsFacts | null {
  const ordered = orderRooms(rooms);
  if (!ordered.length) return null;
  const kinds = ordered.map((r) => ({ ...r, kind: roomNameKind(r.name) }));
  const living = kinds.filter((r) => LIVING.has(r.kind)).map((r) => r.jo);
  const beds = kinds.filter((r) => BEDROOM.has(r.kind));
  const want = bedroomsOfMadori(madori);
  return {
    rooms: ordered,
    living_jo: living.length ? Math.max(...living) : null,
    bedroom_max_jo: roomJoFromImageRooms(ordered, madori ?? null),
    bedroom_count: beds.length,
    count_mismatch: want != null && beds.length > 0 && beds.length !== want,
    label: ordered.map((r) => `${r.name}${r.jo}帖`).join("・"),
  };
}
