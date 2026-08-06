import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";

/* ============================================================
   HORME — Phase 0.5（concept v0.7 準拠）
   Phase 0 の画面・遷移・声・選定ロジックは変更しない。
   このフェーズで足すのは「データが本物になる」ことだけ。

   データ構造の要（Phase 0から変更なし）：
     次の一手 ＝ process_steps の未完了の先頭。tasks / next_action は廃止。
     栞は目標が持つ（常に1つだけ）。三層は 目標 → 工程の先頭 → 栞。
     容量（取り掛かるのに必要なエネルギー）は目標が持つ。工程は順に消化するだけ。
   画面：01 開幕(栞あり) / 02 Focus / 03 調子→候補 / 04 投げ込み /
         06 開幕(栞なし) / いま抱えているもの / 目標の詳細 / 仕分け
         （0.5で追加：はじめる（認証）/ 読み込み中 / はじめまして（初回シード選択））

   工程を主役にしないための歯止め：
     一階層のみ／0個でもいい／Focusには出さない／育ったら独立させる
   ============================================================ */

/* ============================================================
   データアクセス層（Supabase）
   ------------------------------------------------------------
   コンポーネントは Data.* / Auth.* だけを呼ぶ。Supabase の生の形は
   ここに閉じ込める。次段階（オフラインファースト）で中身を
   IndexedDB 経由に差し替えるときも、呼び出し側は触らずに済む。

   SDK（@supabase/supabase-js）は使わない。このプロトタイプは
   Claude のアーティファクト上で動く単一ファイルで、import できる
   ライブラリが限られているため、素の fetch で REST / Auth API を叩く。
   これは正規に公開されている Supabase の HTTP API そのものなので、
   将来 SDK に載せ替えることも問題なくできる。
   ============================================================ */

/* 接続先。.env に書けばそちらが使われる（無ければ下のフォールバックを使う）。
   anon key は公開前提の鍵なので、リポジトリに含まれていても問題ない。
   RLS が有効なので、この鍵だけでは他人のデータには触れない。
   ※ service_role キーは絶対にここへ書かないこと。RLS を貫通する。 */
const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};

const SUPABASE_URL = ENV.VITE_SUPABASE_URL || "https://xinbecreamkzltdchway.supabase.co";
const SUPABASE_ANON_KEY =
  ENV.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhpbmJlY3JlYW1remx0ZGNod2F5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1NTI4MzUsImV4cCI6MjEwMTEyODgzNX0.2YabiEpgon1MVzJpXCE3OEWdo-kaDz3uY0ioFKoIxPA";

/* セッションの保存先。ブラウザでは localStorage を使う。
   （Claude のアーティファクト上で動かす場合だけ window.storage を使う）
   ここが効いていないとリロードのたびにログインし直しになる。 */
const hasArtifactStorage = () => typeof window !== "undefined" && !!window.storage;
const hasLocalStorage = () => {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch (err) {
    return false; // プライベートモード等でアクセス自体が例外になる場合がある
  }
};

async function storageGet(key) {
  if (hasArtifactStorage()) {
    try {
      const r = await window.storage.get(key, false);
      return r ? r.value : null;
    } catch (err) {
      return null; // キーが無い場合も例外になるため、無いものとして扱う
    }
  }
  if (!hasLocalStorage()) return null;
  try { return window.localStorage.getItem(key); } catch (err) { return null; }
}
async function storageSet(key, value) {
  if (hasArtifactStorage()) {
    try { await window.storage.set(key, value, false); } catch (err) {}
    return;
  }
  if (!hasLocalStorage()) return;
  try { window.localStorage.setItem(key, value); } catch (err) {}
}
async function storageDelete(key) {
  if (hasArtifactStorage()) {
    try { await window.storage.delete(key, false); } catch (err) {}
    return;
  }
  if (!hasLocalStorage()) return;
  try { window.localStorage.removeItem(key); } catch (err) {}
}

// crypto.randomUUID が無い環境向けの最小フォールバック
function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function authRequest(path, body, accessToken) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && (data.error_description || data.msg || data.message || data.error)) || `認証でエラーが出た（${res.status}）`;
    throw new Error(msg);
  }
  return data;
}

const Auth = {
  // メールにコードを送る。既存ユーザーでも新規ユーザーでも同じ呼び方でよい。
  sendCode: (email) => authRequest("/otp", { email, create_user: true }),
  // 6桁コードを検証し、成功すればセッション（access/refresh token）が返る
  verifyCode: (email, token) => authRequest("/verify", { type: "email", email, token }),
  refresh: (refresh_token) => authRequest("/token?grant_type=refresh_token", { refresh_token }),
  logout: (accessToken) => authRequest("/logout", {}, accessToken).catch(() => {}), // 失敗しても致命的ではない
};

function sessionFromAuthResponse(data) {
  if (!data || !data.access_token) return null;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    email: data.user && data.user.email,
  };
}

async function saveSession(session) {
  await storageSet("horme-auth-session", JSON.stringify(session));
}
async function loadSession() {
  const raw = await storageGet("horme-auth-session");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}
async function clearSession() {
  await storageDelete("horme-auth-session");
}

async function restRequest(path, { method = "GET", body, accessToken, headers } = {}) {
  const h = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...headers,
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && (data.message || data.error || data.hint)) || `保存でエラーが出た（${res.status}）`;
    throw new Error(msg);
  }
  return data;
}

/* goals: 行 ⇄ ローカルのJS表現。process_steps/steps_done/bookmark はそのまま
   passthrough（JSONBなのでキー名を変える必要が無い）。上位カラムだけ変換する。 */
function goalToRow(g, { forInsert = false } = {}) {
  const row = {
    title: g.title,
    category: g.category ?? null,
    capacity: g.capacity || DEFAULT_CAPACITY,
    important_flag: !!g.important_flag,
    status: g.status,
    process_steps: g.process_steps || [],
    steps_done: g.steps_done || [],
    bookmark: g.bookmark || null,
    progress_felt: g.felt_progress ?? null,
    passed_count: g.passed_count || 0,
    last_passed_at: g.last_passed_at ? new Date(g.last_passed_at).toISOString() : null,
    last_touched_at: new Date(g.last_touched_at || Date.now()).toISOString(),
    completed_at: g.completed_at ? new Date(g.completed_at).toISOString() : null,
    updated_at: new Date(g.updated_at || Date.now()).toISOString(),
  };
  if (forInsert) {
    row.id = g.id;
    row.created_at = new Date(g.created_at || Date.now()).toISOString();
  }
  return row;
}
function rowToGoal(r) {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    capacity: r.capacity || DEFAULT_CAPACITY,
    important_flag: !!r.important_flag,
    status: r.status,
    process_steps: r.process_steps || [],
    steps_done: r.steps_done || [],
    bookmark: r.bookmark || null,
    felt_progress: r.progress_felt ?? null,
    passed_count: r.passed_count || 0,
    last_passed_at: r.last_passed_at ? Date.parse(r.last_passed_at) : null,
    last_touched_at: r.last_touched_at ? Date.parse(r.last_touched_at) : Date.now(),
    completed_at: r.completed_at ? Date.parse(r.completed_at) : null,
    created_at: r.created_at ? Date.parse(r.created_at) : Date.now(),
    updated_at: r.updated_at ? Date.parse(r.updated_at) : Date.now(),
  };
}

function inboxToRow(c) {
  return {
    id: c.id,
    text: c.text,
    source: c.source || "pwa",
    status: "unsorted",
    created_at: new Date(c.created_at || Date.now()).toISOString(),
  };
}
function rowToInbox(r) {
  return {
    id: r.id,
    text: r.text,
    source: r.source,
    status: r.status,
    created_at: r.created_at ? Date.parse(r.created_at) : Date.now(),
  };
}

const Data = {
  goals: {
    list: (token) =>
      restRequest("/goals?select=*&order=created_at.asc", { accessToken: token }).then((rows) => rows.map(rowToGoal)),
    insert: (goal, token) =>
      restRequest("/goals", {
        method: "POST",
        body: goalToRow(goal, { forInsert: true }),
        accessToken: token,
        headers: { Prefer: "return=representation" },
      }).then((rows) => rowToGoal(rows[0])),
    update: (id, goal, token) =>
      restRequest(`/goals?id=eq.${id}`, {
        method: "PATCH",
        body: goalToRow(goal),
        accessToken: token,
        headers: { Prefer: "return=minimal" },
      }),
    remove: (id, token) =>
      restRequest(`/goals?id=eq.${id}`, { method: "DELETE", accessToken: token, headers: { Prefer: "return=minimal" } }),
  },
  inbox: {
    list: (token) =>
      restRequest("/inbox_items?select=*&order=created_at.asc", { accessToken: token }).then((rows) => rows.map(rowToInbox)),
    insert: (item, token) =>
      restRequest("/inbox_items", {
        method: "POST",
        body: inboxToRow(item),
        accessToken: token,
        headers: { Prefer: "return=representation" },
      }).then((rows) => rowToInbox(rows[0])),
    remove: (id, token) =>
      restRequest(`/inbox_items?id=eq.${id}`, { method: "DELETE", accessToken: token, headers: { Prefer: "return=minimal" } }),
  },
};

/* ============================================================
   ここまでデータアクセス層。以降は Phase 0 とほぼ同じ。
   ============================================================ */

// 開発用の操作をUIに出すか。本番ビルドでは false（デッドコードとして落ちる）。
const DEV_TOOLS = true;

/* ---------- 選定の重み・定数（ここだけ触れば挙動が変わる） ---------- */

const WEIGHTS = {
  capacityMatch: 160,
  stalenessPerDay: 2,
  stalenessCapDays: 30,
  importance: 30,
};

const HONMEI = {
  cooldownDays: 3,       // 見送った目標を本命枠に出さない日数
  passesBeforeAsking: 3, // この回数見送られたら、提示の種類を変える
  slotInterval: 3,       // 本命枠を出す間隔（1＝毎回／3＝三回に一度）。常設だと告発席になる。
};

/* 容量は足切り、放置日数はその中での優先順位。
   低調の日に重い本命を出すのは、失敗と恥を生むだけで一つも良いことがない。 */
const HONMEI_ALLOW = {
  快調: ["重", "中"],
  平常: ["中", "軽"],
  低調: ["軽"], // 該当がなければ本命枠は出さない
};

/* 低調の日は本命枠以外でも「重」を出さない。
   快調・平常は足切りせず、スコアの優先で寄せる（軽い一手が出ても害はない）。 */
const TONE_EXCLUDE_CAPACITY = { 低調: ["重"] };

const TONES = ["快調", "平常", "低調", "乱調"];
const TONE_CAPACITY = { 快調: "重", 平常: "中", 低調: "軽" };
const CAPACITY_ORDER = { 軽: 0, 中: 1, 重: 2 };
const CAPACITIES = ["軽", "中", "重"];
const CATEGORIES = ["仕事", "手続き", "学び", "つくる"];

const DAY = 86400000;
const daysAgo = (n) => Date.now() - n * DAY;
const uid = (p) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

// 工程は順に消化するだけ。容量は持たない。
const makeStep = (title) => ({ id: uid("p"), title, done: false });

// 容量＝取り掛かるのに必要なエネルギー。目標の属性。既定は「中」。
const DEFAULT_CAPACITY = "中";
const CAPACITY_NOTE = "取り掛かるのに必要なエネルギー";

/* ---------- 仮データ ---------- */

/* 容量は工程を機械的に集めたものではなく、目標そのものの性質から決める。
   軽＝頭を使わず手が動く／中＝手順は決まっているが判断が要る／重＝新しく覚える・作り出す */
const SEED_GOALS = [
  {
    id: "g1", title: "請求書づくり", category: "仕事",
    capacity: "中",
    important_flag: false, status: "進行中",
    process_steps: [
      { id: "p11", title: "宛名リストをCSVに書き出す", done: false },
      { id: "p12", title: "封筒に宛名を印刷する", done: false },
    ],
    steps_done: [
      { title: "取引先の一覧を作る", at: daysAgo(6), minutes: 45 },
      { title: "先月分の金額を確認する", at: daysAgo(2), minutes: 25 },
    ],
    felt_progress: 40,
    bookmark: { note: "3行目まで入れたところ。", short: "3行目まで", started_step_id: "p11" },
    passed_count: 0, last_passed_at: null,
    last_touched_at: daysAgo(1), created_at: daysAgo(20),
  },
  {
    id: "g2", title: "保険の手続き", category: "手続き",
    capacity: "中",
    important_flag: false, status: "未着手",
    process_steps: [{ id: "p21", title: "書類に記入して封をする", done: false }],
    steps_done: [], felt_progress: null, bookmark: null,
    passed_count: 0, last_passed_at: null,
    last_touched_at: daysAgo(18), created_at: daysAgo(21),
  },
  {
    id: "g3", title: "資格の勉強", category: "学び",
    capacity: "重",
    important_flag: true, status: "進行中",
    process_steps: [
      { id: "p31", title: "テキストを1ページだけ読む", done: false },
      { id: "p32", title: "過去問を10問解く", done: false },
    ],
    steps_done: [
      { title: "テキストを買う", at: daysAgo(12), minutes: 30 },
      { title: "出題範囲を書き写す", at: daysAgo(5), minutes: 55 },
    ],
    felt_progress: null, bookmark: null,
    passed_count: 0, last_passed_at: null,
    last_touched_at: daysAgo(5), created_at: daysAgo(30),
  },
  {
    id: "g4", title: "歯医者の予約を取り直す", category: "手続き",
    capacity: "軽",
    important_flag: false, status: "未着手",
    process_steps: [{ id: "p41", title: "電話して日程を決める", done: false }],
    steps_done: [], felt_progress: null, bookmark: null,
    passed_count: 0, last_passed_at: null,
    last_touched_at: daysAgo(7), created_at: daysAgo(7),
  },
  {
    id: "g5", title: "確定申告の準備", category: "手続き",
    capacity: "中",
    important_flag: true, status: "未着手",
    process_steps: [
      { id: "p51", title: "必要書類をそろえる", done: false },
      { id: "p52", title: "領収書を月ごとに分ける", done: false },
    ],
    steps_done: [], felt_progress: null, bookmark: null,
    passed_count: 0, last_passed_at: null,
    last_touched_at: daysAgo(31), created_at: daysAgo(40),
  },
  {
    id: "g6", title: "本棚を組み立てる", category: "つくる",
    capacity: "軽",
    important_flag: false, status: "未着手",
    process_steps: [], // 工程は0個でもいい
    steps_done: [], felt_progress: null, bookmark: null,
    passed_count: 0, last_passed_at: null,
    last_touched_at: daysAgo(9), created_at: daysAgo(14),
  },
  {
    id: "g7", title: "アプリを作る", category: "つくる",
    capacity: "重",
    important_flag: true, status: "進行中",
    process_steps: [
      { id: "p71", title: "作りたいものを書き出す", done: true },
      { id: "p72", title: "画面の並びを決める", done: true },
      { id: "p73", title: "画面の下書きを描く", done: false },
      { id: "p74", title: "配色を決める", done: false },
      { id: "p75", title: "触れるところまで組む", done: false },
    ],
    steps_done: [
      { title: "作りたいものを書き出す", at: daysAgo(16), minutes: 60 },
      { title: "画面の並びを決める", at: daysAgo(11), minutes: 90 },
    ],
    felt_progress: null, bookmark: null,
    passed_count: 0, last_passed_at: null,
    last_touched_at: daysAgo(11), created_at: daysAgo(45),
  },
  {
    id: "g8", title: "短編を書き上げる", category: "つくる",
    capacity: "重",
    important_flag: true, status: "進行中",
    process_steps: [{ id: "p81", title: "続きを一段落だけ書く", done: false }],
    steps_done: [{ title: "書き出しを三通り試す", at: daysAgo(23), minutes: 75 }],
    felt_progress: null, bookmark: null,
    passed_count: 0, last_passed_at: null,
    last_touched_at: daysAgo(23), created_at: daysAgo(60),
  },
  {
    id: "g9", title: "たまった書類を片づける", category: "仕事",
    capacity: "軽",
    important_flag: true, status: "未着手",
    process_steps: [
      { id: "p91", title: "机の上の紙を一箇所に集める", done: false },
      { id: "p92", title: "捨てるものを抜く", done: false },
    ],
    steps_done: [], felt_progress: null, bookmark: null,
    passed_count: 0, last_passed_at: null,
    last_touched_at: daysAgo(13), created_at: daysAgo(25),
  },
];

const SEED_CAPTURES = [
  { id: "c1", text: "confluenceのリンク探しておく", created_at: daysAgo(2), source: "pwa", status: "unsorted" },
  { id: "c2", text: "母の誕生日、来月の頭", created_at: daysAgo(1), source: "pwa", status: "unsorted" },
  { id: "c3", text: "車のオイル交換そろそろ", created_at: daysAgo(1), source: "pwa", status: "unsorted" },
  { id: "c4", text: "確定申告、e-Taxのカード読み取り試す", created_at: daysAgo(1), source: "pwa", status: "unsorted" },
  { id: "c5", text: "コート出しておく", created_at: daysAgo(3), source: "pwa", status: "unsorted" },
];

/* ---------- 次の一手＝工程の未完了の先頭 ---------- */

const nextStepOf = (goal) => (goal.process_steps || []).find((s) => !s.done) || null;
const hasProcess = (goal) => (goal.process_steps || []).length > 0;
const isLive = (g) => g.status !== "完了" && g.status !== "寝かせ";

/* つづき枠を占有できるのは「本当に途中で止めたもの」だけ。
   一手を終えた直後に自動で引き継がれる空の栞は、進行中の目印には残るが、
   候補の枠は取らない（取ると最後に触った目標が全調子の1枠目に居座るため）。
   判定：追記がある、または 始めた一手をまだ終えていない。 */
const CONTINUE_NEEDS_PROGRESS = true;

function isResumable(goal) {
  const bm = goal.bookmark;
  if (!bm) return false;
  if (!CONTINUE_NEEDS_PROGRESS) return true;
  if (bm.note && bm.note.trim()) return true;
  const head = nextStepOf(goal);
  return !!(head && bm.started_step_id && bm.started_step_id === head.id);
}
const staleDays = (goal) => Math.floor((Date.now() - goal.last_touched_at) / DAY);
const totalMinutes = (goal) => goal.steps_done.reduce((s, x) => s + (x.minutes || 0), 0);

// 栞は常に1つ（開いた時に迷わないため）
function withSingleBookmark(goals, goalId, bookmark) {
  return goals.map((g) => {
    if (g.id === goalId) return { ...g, bookmark: bookmark || g.bookmark || { note: "", short: "" } };
    return g.bookmark ? { ...g, bookmark: null } : g;
  });
}

/* ---------- 選定ヒューリスティック（AI非依存） ---------- */

function capacityMatch(capacity, wanted) {
  const d = Math.abs(CAPACITY_ORDER[capacity] - CAPACITY_ORDER[wanted]);
  return d === 0 ? 1 : d === 1 ? 0.4 : 0;
}

// 容量は目標の属性。調子は「どの目標に向かうか」を選ぶ。
function scoreOf(goal, tone) {
  const wanted = TONE_CAPACITY[tone] || "中";
  const match = capacityMatch(goal.capacity || DEFAULT_CAPACITY, wanted) * WEIGHTS.capacityMatch;
  const stale = Math.min(staleDays(goal), WEIGHTS.stalenessCapDays) * WEIGHTS.stalenessPerDay;
  const important = goal.important_flag ? WEIGHTS.importance : 0;
  return match + stale + important;
}

function onCooldown(goal, ignoreCooldown) {
  if (ignoreCooldown) return false;
  if (!goal.last_passed_at) return false;
  return Date.now() - goal.last_passed_at < HONMEI.cooldownDays * DAY;
}

const capacityOf = (goal) => goal.capacity || DEFAULT_CAPACITY;

/**
 * 容量は目標の属性なので、調子は「どの目標に向かうか」を決める。
 * 快調＝重／平常＝中／低調＝軽 を優先（除外ではなく優先）。
 * 乱調：発散モード（容量では選ばない・2枚・1枚目は書き出す・本命枠なし）
 * 低調で軽い目標が一つも出せない日は、割る導線を添える。
 *
 * つづき（中断中のもの）は、その目標の容量と一致する調子でだけ先頭に固定する。
 * 例：請求書づくり（中）が中断中なら、平常では必ず一枠目。快調・低調では固定せず、
 *     その調子に合う目標を先に見せる（中断中のものも点数次第では後ろの枠に出る）。
 * 固定された枠は「いまはどれも違う」で送っても残るので、中断が放置されない。
 */
function selectCandidates({ tone, goals, excludeIds, lastHonmeiGoalId, sortCount, ignoreCooldown }) {
  const lowTone = tone === "低調";
  const wanted = TONE_CAPACITY[tone] || null;

  const all = goals
    .filter((g) => isLive(g) && nextStepOf(g))
    .map((g) => ({ goal: g, step: nextStepOf(g) }));

  // 容量が一致する調子のときだけ、中断中のものを先頭に固定する
  const pinned = wanted ? all.find((x) => isResumable(x.goal) && capacityOf(x.goal) === wanted) : null;

  // 固定された一件だけは「どれも違う」の除外を免れる
  const notExcluded = all.filter(
    (x) => !excludeIds.includes(x.goal.id) || (pinned && x.goal.id === pinned.goal.id)
  );

  // 調子による容量の足切り（低調に「重」を出さない）。固定枠は免れる。
  const banned = TONE_EXCLUDE_CAPACITY[tone] || [];
  const pool = notExcluded.filter(
    (x) => !banned.includes(capacityOf(x.goal)) || (pinned && x.goal.id === pinned.goal.id)
  );

  const entry = (x, mark) => ({
    kind: "task",
    id: `${x.goal.id}:${x.step.id}`,
    goal: x.goal,
    step: x.step,
    mark,
    suggestSplit: false,
  });

  /* --- 乱調：戦わずに収穫へ回す（容量では選ばない） --- */
  if (tone === "乱調") {
    const out = [{ kind: "writeout", id: "writeout" }];
    const mechanical = pool.slice().sort((a, b) => {
      const movingA = a.goal.status === "進行中" ? 0 : 1;
      const movingB = b.goal.status === "進行中" ? 0 : 1;
      if (movingA !== movingB) return movingA - movingB;
      return staleDays(a.goal) - staleDays(b.goal);
    });
    if (mechanical[0]) out.push(entry(mechanical[0], null));
    return out;
  }

  const picked = [];
  const used = new Set();
  const push = (x, mark) => { picked.push(entry(x, mark)); used.add(x.goal.id); };

  // ① つづき枠：容量が調子と一致する中断中のものだけ、先頭に固定
  if (pinned) push(pinned, "つづき");

  // ② 本命枠：容量で足切りしてから、その中で最も放置されているものを選ぶ。
  //    数回に一度だけ出す（常設だと告発席になる）。
  const allowed = HONMEI_ALLOW[tone] || [];
  if (allowed.length > 0 && sortCount % HONMEI.slotInterval === 0) {
    const eligible = pool
      .filter((x) => x.goal.important_flag && !used.has(x.goal.id) && !onCooldown(x.goal, ignoreCooldown))
      .filter((x) => allowed.includes(capacityOf(x.goal)))
      .sort((a, b) => staleDays(b.goal) - staleDays(a.goal));

    const rotated = [
      ...eligible.filter((x) => x.goal.id !== lastHonmeiGoalId),
      ...eligible.filter((x) => x.goal.id === lastHonmeiGoalId),
    ];
    const target = rotated[0];

    if (target) {
      if (target.goal.passed_count >= HONMEI.passesBeforeAsking) {
        picked.push({ kind: "reconsider", id: `reconsider-${target.goal.id}`, goal: target.goal, step: target.step, mark: null });
        used.add(target.goal.id);
      } else {
        push(target, "本命");
      }
    }
  }

  // ③ 残り枠：調子に合う容量からスコア順
  const rest = pool
    .filter((x) => !used.has(x.goal.id))
    .sort((a, b) => scoreOf(b.goal, tone) - scoreOf(a.goal, tone));
  for (const x of rest) {
    if (picked.length >= 3) break;
    push(x, null);
  }

  // 印を整える。中断中のものは固定枠でなくても「つづき」と分かるようにする。
  const marked = picked.map((c) => {
    if (c.kind !== "task" || c.mark) return c;
    if (isResumable(c.goal)) return { ...c, mark: "つづき" };
    if (capacityOf(c.goal) === "軽") return { ...c, mark: "かるい" };
    return c;
  });

  // 低調の日に軽い目標が一つも出せなかったら、割る導線を添える
  const noLightToday = lowTone && !marked.some((c) => c.goal && capacityOf(c.goal) === "軽");
  return noLightToday
    ? marked.map((c) => (c.kind === "task" ? { ...c, suggestSplit: true } : c))
    : marked;
}

/* ---------- 再発防止：調子が候補に効いているかを測る ----------
   3枠のうち何枠が調子で変わるか、全調子に共通で出る一手が無いかを見る。
   枠が固定席になった時（今回の不具合）は、ここに必ず現れる。 */
function diagnoseTones(goals) {
  const tones = ["快調", "平常", "低調"];
  const base = { excludeIds: [], lastHonmeiGoalId: null, ignoreCooldown: false };
  // 本命枠は数回に一度なので、出る回を選んで測る
  const lists = tones.map((t) => selectCandidates({ tone: t, goals, sortCount: HONMEI.slotInterval, ...base }));

  const slots = [0, 1, 2].map((i) => {
    const names = lists.map((l) => (l[i] && l[i].step ? l[i].step.title : null));
    const filled = names.filter(Boolean);
    return {
      no: i + 1,
      names,
      stuck: filled.length === tones.length && new Set(filled).size === 1,
    };
  });

  const sets = lists.map((l) => new Set(l.filter((x) => x.step).map((x) => x.step.title)));
  const common = sets.length ? [...sets[0]].filter((n) => sets.every((s) => s.has(n))) : [];
  const varying = slots.filter((s) => !s.stuck && s.names.some(Boolean)).length;

  // 容量の規律：低調に「重」が出ていないか、本命枠が足切りを守っているか
  const violations = [];
  tones.forEach((t, i) => {
    const banned = TONE_EXCLUDE_CAPACITY[t] || [];
    const allowed = HONMEI_ALLOW[t] || [];
    lists[i].forEach((c) => {
      if (!c.goal) return;
      const cap = capacityOf(c.goal);
      if (banned.includes(cap) && c.mark !== "つづき") {
        violations.push(`${t}に${cap}「${c.goal.title}」`);
      }
      if (c.mark === "本命" && !allowed.includes(cap)) {
        violations.push(`${t}の本命枠に${cap}「${c.goal.title}」`);
      }
    });
  });

  return { tones, lists, slots, common, varying, violations };
}

/* ---------- 表示ヘルパ ---------- */

const KANJI = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const kanji = (n) => KANJI[n] || String(n);

const formatClock = (d) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function relativeDay(ts) {
  const d = Math.floor((Date.now() - ts) / DAY);
  if (d <= 0) return "今日";
  if (d === 1) return "昨日";
  return `${d}日前`;
}

function formatDuration(min) {
  if (!min || min <= 0) return "0分";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

// 進行度：体感%が入っていればそれが主。無ければ工程ベース。
function progressOf(goal) {
  if (typeof goal.felt_progress === "number") {
    return { kind: "felt", ratio: Math.max(0, Math.min(100, goal.felt_progress)) / 100, label: `${goal.felt_progress}%` };
  }
  if (hasProcess(goal)) {
    const total = goal.process_steps.length;
    const done = goal.process_steps.filter((s) => s.done).length;
    return { kind: "process", ratio: total ? done / total : 0, label: `${done}／${total}` };
  }
  return null;
}

/* ------------------------------ CSS ------------------------------ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@500;700&family=Noto+Sans+JP:wght@400;500;600&display=swap');

.horme-stage, .horme-stage *, .horme-stage *::before, .horme-stage *::after { box-sizing: border-box; }

.horme-stage {
  --bg: #17130f;
  --paper: #efe9db;
  --paper-2: #e6ded0;
  --ink: #241f1a;
  --ink-soft: #7a715f;
  --ink-faint: rgba(36,31,26,0.14);
  --cream: #ece6d8;
  --cream-muted: #8d846f;
  --vermilion: #bd3f21;
  --vermilion-ink: #fbf2e9;

  min-height: 100vh; width: 100%;
  display: flex; flex-direction: column; align-items: center; gap: 20px;
  padding: 36px 16px 60px;
  background: #0d0b09;
  font-family: "Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
}

.horme-frame {
  position: relative; width: 100%; max-width: 390px;
  height: 790px; max-height: 90vh;
  border-radius: 38px; overflow: hidden; background: var(--bg);
  box-shadow: 0 30px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.045);
  display: flex; flex-direction: column;
}

@media (max-width: 460px) {
  .horme-stage { padding: 0 0 40px; gap: 24px; }
  .horme-frame { max-width: 100%; height: 100dvh; max-height: 100dvh; border-radius: 0; box-shadow: none; }
}

.horme-statusbar {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  padding: 16px 22px 10px; color: var(--cream-muted);
}
.horme-statusbar .clock { font-size: 12px; letter-spacing: 0.04em; color: var(--cream); }
.horme-statusbar .wordmark { font-size: 11px; font-weight: 600; letter-spacing: 0.22em; color: var(--cream-muted); }

.horme-screen {
  position: relative; flex: 1 1 auto; min-height: 0;
  background: var(--paper);
  background-image:
    repeating-linear-gradient(0deg, rgba(36,31,26,0.025) 0px, rgba(36,31,26,0.025) 1px, transparent 1px, transparent 3px),
    repeating-linear-gradient(90deg, rgba(36,31,26,0.018) 0px, rgba(36,31,26,0.018) 1px, transparent 1px, transparent 3px);
  color: var(--ink);
  transition: filter 0.25s ease;
}
.horme-screen.dimmed { filter: blur(1.5px) saturate(0.85); }

.screen-col {
  height: 100%; display: flex; flex-direction: column;
  padding: 26px 24px 26px;
  animation: fadeSlideIn 0.32s ease-out;
}
@keyframes fadeSlideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

.spacer { flex: 1 1 auto; }

.eyebrow { font-size: 12px; letter-spacing: 0.14em; color: var(--ink-soft); margin: 0 0 10px; }
.hint-text { font-size: 12px; color: var(--ink-soft); margin: 0 0 14px; }
.goal-line { font-size: 12.5px; color: var(--ink-soft); margin: 0 0 6px; letter-spacing: 0.04em; }

.goal-line-btn {
  background: none; border: none; padding: 0; font-family: inherit;
  font-size: 12.5px; color: var(--ink-soft); letter-spacing: 0.04em;
  margin: 0 0 6px; text-align: left; cursor: pointer;
}
.goal-line-btn:hover { color: var(--ink); }
.end-goal-row { margin: 0 0 10px; }
.end-goal-btn {
  background: transparent; border: 1px solid var(--ink-faint); border-radius: 8px;
  font-family: inherit; font-size: 12.5px; color: var(--ink); padding: 6px 12px;
}

.tag-pill {
  display: inline-block; font-size: 11px; letter-spacing: 0.08em; color: var(--ink-soft);
  border: 1px solid var(--ink-faint); border-radius: 999px; padding: 4px 11px;
  margin: 0 0 20px; width: fit-content;
}

.headline {
  font-family: "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
  font-weight: 700; font-size: 27px; line-height: 1.45;
  color: var(--ink); margin: 0 0 12px; letter-spacing: 0.01em;
}

.meta-stack { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--ink-soft); }

.focus-top {
  display: flex; align-items: baseline; justify-content: space-between;
  font-size: 12px; color: var(--ink-soft); margin-bottom: 30px; opacity: 0.8;
}

.bottom-actions {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  padding-top: 18px; border-top: 1px solid var(--ink-faint);
}
.rest-row {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  gap: 10px; padding-top: 14px;
}
.rest-row.solo { justify-content: flex-end; }

button { cursor: pointer; }
.btn-plain, .btn-advance, .btn-muted { background: none; border: none; font-family: inherit; padding: 6px 2px; }
.btn-plain { font-size: 14px; color: var(--ink-soft); }
.btn-plain.small { font-size: 12.5px; }
.btn-plain.listening { color: var(--vermilion); }
.btn-plain:disabled { opacity: 0.35; cursor: default; }
.btn-advance { font-size: 15px; font-weight: 600; color: var(--ink); }
.btn-advance:disabled { color: var(--ink-faint); cursor: default; }
.btn-muted { font-size: 12.5px; color: var(--ink-soft); opacity: 0.72; }
.btn-muted:hover { opacity: 1; }

.inline-edit { display: flex; align-items: center; gap: 10px; padding-top: 18px; border-top: 1px solid var(--ink-faint); }
.inline-input {
  flex: 1 1 auto; min-width: 0; background: var(--paper-2);
  border: 1px solid var(--ink-faint); border-radius: 8px; padding: 8px 10px;
  font-size: 14px; color: var(--ink); font-family: inherit;
}
.inline-input:focus-visible { outline: 2px solid var(--vermilion); outline-offset: 1px; }

.tone-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 24px; }
.tone-btn {
  border: 1px solid var(--ink-faint); background: transparent; color: var(--ink-soft);
  font-size: 13px; font-family: inherit; padding: 10px 4px; border-radius: 9px;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.tone-btn.selected { background: var(--vermilion); border-color: var(--vermilion); color: var(--vermilion-ink); font-weight: 600; }
.tone-btn:focus-visible { outline: 2px solid var(--vermilion); outline-offset: 2px; }

.counter-row { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 2px; }
.counter-row .eyebrow { margin-bottom: 0; }
.counter-label { font-size: 12px; color: var(--ink-soft); }

.candidate-card {
  position: relative; flex: 1 1 auto; min-height: 0;
  margin: 14px 0 4px; padding: 18px 4px 4px;
  touch-action: pan-y; user-select: none;
  display: flex; flex-direction: column;
  animation: cardIn 0.28s ease-out;
}
@keyframes cardIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; } }
.candidate-tag {
  display: inline-block; font-size: 11px; letter-spacing: 0.06em; color: var(--ink-soft);
  border: 1px solid var(--ink-faint); border-radius: 999px; padding: 3px 10px;
  width: fit-content; margin-bottom: 12px;
}
.candidate-tag.accent { background: var(--vermilion); border-color: var(--vermilion); color: var(--vermilion-ink); }
.candidate-text {
  font-family: "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
  font-weight: 700; font-size: 23px; line-height: 1.5; color: var(--ink); margin: 0 0 10px;
}
.candidate-meta { font-size: 13px; color: var(--ink-soft); margin: 0; }
.split-hint { margin-top: 16px; }
.split-hint-note { font-size: 12.5px; color: var(--ink-soft); margin: 0 0 8px; }

/* 容量の三つ。格付けに見えないよう、同じ幅・同じ字面で等しく並べる。 */
.capacity-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 6px; max-width: 260px; }
.capacity-btn {
  border: 1px solid var(--ink-faint); background: transparent; color: var(--ink-soft);
  font-family: inherit; font-size: 13px; font-weight: 400;
  padding: 9px 4px; border-radius: 9px; text-align: center;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.capacity-btn.selected { background: var(--vermilion); border-color: var(--vermilion); color: var(--vermilion-ink); font-weight: 600; }
.capacity-note { font-size: 12px; color: var(--ink-soft); margin: 0; opacity: 0.85; }
.split-hint-btn {
  background: transparent; border: 1px solid var(--ink-faint); border-radius: 9px;
  color: var(--ink-soft); font-family: inherit; font-size: 13px; padding: 8px 14px;
}
.split-hint-btn:hover { color: var(--ink); border-color: var(--ink-soft); }

.reconsider-note { font-size: 13px; color: var(--ink-soft); margin: 0 0 20px; }
.reconsider-actions { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.reconsider-btn, .choice-btn {
  background: transparent; border: 1px solid var(--ink-faint); border-radius: 9px;
  color: var(--ink); font-family: inherit; font-size: 14px; padding: 10px 16px; text-align: left;
}
.reconsider-btn:hover, .choice-btn:hover { border-color: var(--ink-soft); }

.empty-note { font-size: 14px; color: var(--ink-soft); margin: 26px 0 0; }

/* ---- いま抱えているもの ---- */
.shelf-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
.goal-row { padding: 15px 0; border-bottom: 1px solid var(--ink-faint); }
.goal-row:first-child { padding-top: 0; }
.goal-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.goal-title-btn {
  background: none; border: none; padding: 0; text-align: left; cursor: pointer;
  font-family: "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
  font-weight: 700; font-size: 17px; line-height: 1.45; color: var(--ink);
}
.goal-title-btn:hover { color: var(--vermilion); }
.goal-cat { flex: 0 0 auto; font-size: 11.5px; color: var(--ink-soft); }
.goal-line-row { font-size: 13px; line-height: 1.7; color: var(--ink-soft); margin: 0; }
.goal-line-row .lead { opacity: 0.75; }
.goal-line-row.next { color: var(--ink); }

.progress-wrap { display: flex; align-items: center; gap: 9px; margin-top: 9px; }
.progress-bar { flex: 1 1 auto; height: 3px; background: var(--ink-faint); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--ink-soft); border-radius: 2px; }
.progress-label { flex: 0 0 auto; font-size: 11.5px; color: var(--ink-soft); }

.shelf-block { margin-top: 18px; padding-top: 15px; border-top: 1px solid var(--ink-faint); }
.shelf-block-btn {
  width: 100%; background: none; border: none; padding: 0; font-family: inherit; cursor: pointer;
  display: flex; align-items: baseline; justify-content: space-between;
  font-size: 13px; color: var(--ink-soft);
}
.shelf-block-btn:hover { color: var(--ink); }
.shelf-block-btn .n { font-size: 15px; color: var(--ink); }
.folded-list { margin: 12px 0 0; padding: 0; list-style: none; }
.folded-item {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  padding: 8px 0; font-size: 13px; color: var(--ink-soft);
}
.folded-item .name { flex: 1 1 auto; color: var(--ink); text-align: left; }
.folded-item button.name { background: none; border: none; padding: 0; font-family: inherit; font-size: 13px; cursor: pointer; }
.folded-item button.name:hover { color: var(--vermilion); }
.folded-when { flex: 0 0 auto; font-size: 11.5px; }

/* ---- 目標の詳細 ---- */
.detail-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
.detail-title {
  font-family: "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
  font-weight: 700; font-size: 21px; line-height: 1.45; color: var(--ink); margin: 0 0 4px;
}
.detail-sum { font-size: 13px; color: var(--ink-soft); margin: 0 0 4px; }
.detail-section { margin-top: 22px; }
.detail-section > .eyebrow { margin-bottom: 8px; }
.history-item {
  display: grid; grid-template-columns: auto 1fr auto; gap: 10px;
  font-size: 12.5px; color: var(--ink-soft); padding: 5px 0;
}
.history-item .t { color: var(--ink); }
.row-line { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.row-line .grow { flex: 1 1 auto; min-width: 0; font-size: 13.5px; color: var(--ink); }
.step-row { position: relative; background: var(--paper); will-change: transform; }
.step-head-mark { flex: 0 0 auto; font-size: 11px; color: var(--ink-soft); opacity: 0.7; }

.next-now {
  background: none; border: none; padding: 8px 0; font-family: inherit; text-align: left; cursor: pointer;
  font-size: 15px; color: var(--ink);
}
.next-now.empty { color: var(--ink-soft); opacity: 0.7; }
.next-now:hover { color: var(--vermilion); }

.step-arrow {
  flex: 0 0 auto;
  background: transparent; border: 1px solid var(--ink-faint); border-radius: 7px;
  color: var(--ink-soft); font-family: inherit; font-size: 11.5px;
  padding: 4px 8px; line-height: 1.2;
  transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.step-arrow:hover:not(:disabled) { background: rgba(36,31,26,0.045); }
.step-arrow:disabled { opacity: 0.26; cursor: default; }
.step-arrow.pressed { background: #fdfaf2; border-color: var(--ink); color: var(--ink); transition: none; }

.mini-btn {
  background: transparent; border: 1px solid var(--ink-faint); border-radius: 7px;
  color: var(--ink-soft); font-family: inherit; font-size: 11.5px; padding: 4px 8px;
}
.mini-btn:hover { color: var(--ink); border-color: var(--ink-soft); }
.mini-btn.on { background: var(--vermilion); border-color: var(--vermilion); color: var(--vermilion-ink); }
.chip-row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 4px; }
.step-done { text-decoration: line-through; opacity: 0.5; }
.step-left { opacity: 0.45; }

.detail-end { padding-top: 6px; }
.end-btn {
  background: transparent; border: 1px solid var(--ink-soft); border-radius: 9px;
  font-family: "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
  font-weight: 700; font-size: 15px; color: var(--ink); padding: 12px 22px;
}
.end-btn:hover { background: rgba(36,31,26,0.05); }
.detail-sleep { margin-top: 16px; }
.sleep-btn {
  background: none; border: none; padding: 4px 0; font-family: inherit;
  font-size: 12.5px; color: var(--ink-soft); opacity: 0.8;
  text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--ink-faint);
}
.sleep-btn:hover { opacity: 1; }
.pct-input { width: 74px; flex: 0 0 auto; }
.pct-main { font-size: 15px; color: var(--ink); }
.pct-sub { font-size: 12px; color: var(--ink-soft); opacity: 0.8; margin: 8px 0 0; }

/* ---- 仕分け ---- */
.sort-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
.sort-row { padding: 14px 0; border-bottom: 1px solid var(--ink-faint); }
.sort-row:first-child { padding-top: 0; }
.sort-row-text {
  font-family: "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
  font-weight: 700; font-size: 16px; line-height: 1.55; color: var(--ink); margin: 0 0 10px;
}
.sort-row-actions { display: flex; align-items: center; gap: 10px; }
.sort-text {
  font-family: "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
  font-weight: 700; font-size: 22px; line-height: 1.55; color: var(--ink); margin: 18px 0 24px;
}
.sort-form { display: flex; flex-direction: column; gap: 12px; }
.field-label { font-size: 12px; color: var(--ink-soft); margin: 0 0 5px; }
.wide { width: 100%; }

/* ---- 声 ---- */
.voice-overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px; padding: 40px;
  background: rgba(23,19,15,0.62); pointer-events: none;
  opacity: 0;
  animation-name: voiceFade; animation-duration: 1400ms;
  animation-timing-function: ease-in-out; animation-fill-mode: forwards;
}
@keyframes voiceFade { 0% { opacity: 0; } 14% { opacity: 1; } 82% { opacity: 1; } 100% { opacity: 0; } }
.voice-text {
  font-family: "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
  font-size: 19px; line-height: 1.7; color: var(--cream); text-align: center; margin: 0;
}
.voice-sub { font-size: 13px; color: var(--cream-muted); margin: 0; letter-spacing: 0.04em; }

/* ---- 一手の締め（声と同じ場所） ---- */
.closing-backdrop {
  position: absolute; inset: 0; background: rgba(23,19,15,0.72);
  display: flex; align-items: center; justify-content: center; padding: 30px 26px;
  animation: closingIn 0.3s ease-out;
}
@keyframes closingIn { from { opacity: 0; } to { opacity: 1; } }
.closing-panel { width: 100%; display: flex; flex-direction: column; gap: 16px; }
.closing-panel .voice-text, .closing-panel .voice-sub { text-align: left; }
.closing-field { margin-top: 6px; }
.closing-field .field-label { color: var(--cream-muted); }
.closing-input {
  width: 100%; background: transparent; border: none; border-bottom: 1px solid rgba(236,230,216,0.28);
  padding: 7px 2px 9px; font-family: inherit; font-size: 15px; color: var(--cream);
}
.closing-input::placeholder { color: rgba(236,230,216,0.32); }
.closing-input:focus-visible { outline: none; border-color: var(--cream-muted); }
.closing-next { font-size: 14px; color: var(--cream-muted); margin: 0; }
.closing-end {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 10px; font-size: 13.5px; color: var(--cream-muted);
}
.closing-end-btn {
  background: transparent; border: 1px solid rgba(236,230,216,0.3); border-radius: 8px;
  color: var(--cream); font-family: inherit; font-size: 13px; padding: 6px 14px;
}
.closing-actions { display: flex; justify-content: flex-end; padding-top: 4px; }
.closing-go { background: none; border: none; font-family: inherit; font-size: 15px; font-weight: 600; color: var(--cream); }

/* ---- 投げ込み ---- */
.capture-backdrop { position: absolute; inset: 0; background: rgba(23,19,15,0.42); display: flex; align-items: flex-end; padding: 18px; }
.capture-sheet {
  width: 100%; background: var(--paper-2); border-radius: 16px; padding: 20px 20px 18px;
  box-shadow: 0 14px 40px rgba(0,0,0,0.35); animation: sheetUp 0.24s ease-out;
}
@keyframes sheetUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
.capture-input {
  width: 100%; resize: none; background: transparent; border: none;
  border-bottom: 1px solid var(--ink-faint); padding: 8px 2px 12px;
  font-family: "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif;
  font-size: 18px; color: var(--ink); margin-bottom: 14px;
}
.capture-input:focus-visible { outline: none; border-color: var(--ink-soft); }
.capture-actions { display: flex; align-items: center; justify-content: space-between; }

.bottom-handle-zone {
  position: absolute; left: 0; right: 0; bottom: 0; height: 32px;
  display: flex; align-items: flex-end; justify-content: center; padding-bottom: 9px; cursor: grab;
}
.bottom-handle { width: 42px; height: 4px; border-radius: 999px; background: var(--ink-soft); opacity: 0.26; }

.grace-line { height: 2px; background: var(--ink-faint); border-radius: 2px; overflow: hidden; margin-bottom: 20px; }
.grace-fill { height: 100%; width: 100%; background: var(--ink-soft); transform-origin: left; animation: graceShrink 10s linear forwards; }
@keyframes graceShrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }

.dev-panel { width: 100%; max-width: 390px; color: #8d8677; font-size: 12px; }
.dev-label { margin: 0 0 8px; letter-spacing: 0.04em; }
.dev-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dev-btn {
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09);
  color: #cfc8b8; font-family: inherit; font-size: 12px; padding: 7px 12px; border-radius: 8px;
}
.dev-btn:hover { background: rgba(255,255,255,0.09); }
.dev-btn.on { border-color: rgba(189,63,33,0.7); color: #e8b8a6; }

.diag { margin-top: 14px; border-top: 1px solid rgba(255,255,255,0.09); padding-top: 12px; }
.diag h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #cfc8b8; letter-spacing: 0.04em; }
.diag-line { display: flex; gap: 8px; padding: 4px 0; font-size: 11.5px; line-height: 1.5; }
.diag-key { flex: 0 0 46px; color: #8d8677; }
.diag-val { flex: 1 1 auto; color: #a89f8c; }
.diag-ok { color: #8fae86; }
.diag-ng { color: #e0806a; }
.diag-note { margin: 8px 0 0; font-size: 11px; color: #8d8677; line-height: 1.6; }

.dev-logout-row { width: 100%; max-width: 390px; }
.dev-logout-btn {
  background: none; border: none; padding: 0; font-family: inherit;
  font-size: 11.5px; color: #746c5e; text-decoration: underline; text-underline-offset: 2px;
}
.dev-logout-btn:hover { color: #cfc8b8; }

.sync-note { width: 100%; max-width: 390px; margin-top: -8px; font-size: 11.5px; color: #a8776b; }

/* ---- 0.5: 読み込み中 ---- */
.loading-wrap { height: 100%; display: flex; align-items: center; justify-content: center; }
.loading-text { font-size: 13px; color: var(--ink-soft); letter-spacing: 0.06em; }

/* ---- 0.5: はじめる（認証） ---- */
.auth-copy { font-size: 13.5px; color: var(--ink-soft); line-height: 1.8; margin: 0 0 22px; }
.auth-field { margin-bottom: 16px; }
.auth-input {
  width: 100%; background: var(--paper-2); border: 1px solid var(--ink-faint); border-radius: 9px;
  padding: 12px 14px; font-size: 15px; color: var(--ink); font-family: inherit;
}
.auth-input:focus-visible { outline: 2px solid var(--vermilion); outline-offset: 1px; }
.auth-error { font-size: 12.5px; color: var(--ink-soft); margin: 10px 0 0; line-height: 1.6; }
.auth-links { display: flex; gap: 16px; margin-top: 16px; }

/* ---- 0.5: はじめまして（初回シード選択） ---- */
.welcome-choices { display: flex; flex-direction: column; gap: 10px; margin-top: 20px; }
.welcome-btn {
  border: 1px solid var(--ink-faint); background: transparent; border-radius: 10px;
  padding: 14px 16px; text-align: left; font-family: inherit;
}
.welcome-btn-title { font-size: 15px; color: var(--ink); margin: 0 0 3px; font-weight: 600; }
.welcome-btn-sub { font-size: 12.5px; color: var(--ink-soft); margin: 0; }
.welcome-btn:hover { border-color: var(--ink-soft); }
.welcome-btn:disabled { opacity: 0.5; }

button:focus-visible, .bottom-handle-zone:focus-visible { outline: 2px solid var(--vermilion); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  .screen-col, .candidate-card, .voice-overlay, .capture-sheet, .closing-backdrop, .grace-fill { animation: none !important; }
  .voice-overlay { opacity: 1 !important; }
}
`;

/* ------------------------------ 部品 ------------------------------ */

/* 0.5: 読み込み中（セッション復元／初回データ取得の間だけ） */
function LoadingScreen() {
  return (
    <div className="screen-col">
      <div className="loading-wrap">
        <p className="loading-text">読み込み中</p>
      </div>
    </div>
  );
}

/* 0.5: はじめる（メール→コードの2段階。パスワードなし・毎回は聞かない） */
function AuthGate({ mode, email, setEmail, code, setCode, busy, error, onSend, onVerify, onResend, onBack }) {
  if (mode === "code") {
    return (
      <div className="screen-col">
        <p className="eyebrow">コードを送った</p>
        <h1 className="headline">確認する</h1>
        <p className="auth-copy">{email} に届いた6桁のコードを入れて。</p>
        <div className="auth-field">
          <input
            autoFocus
            className="auth-input"
            inputMode="numeric"
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) onVerify(); }}
          />
        </div>
        {error && <p className="auth-error">{error}</p>}
        <div className="spacer" />
        <div className="auth-links">
          <button className="btn-plain" onClick={onBack} disabled={busy}>← メールを変える</button>
          <button className="btn-plain" onClick={onResend} disabled={busy}>もう一度送る</button>
        </div>
        <div className="bottom-actions">
          <span />
          <button className="btn-advance" onClick={onVerify} disabled={busy || !code.trim()}>確認する →</button>
        </div>
      </div>
    );
  }
  return (
    <div className="screen-col">
      <p className="eyebrow">はじめる</p>
      <h1 className="headline">Horme</h1>
      <p className="auth-copy">メールアドレスにコードを送る。パスワードは無い。</p>
      <div className="auth-field">
        <input
          autoFocus
          className="auth-input"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) onSend(); }}
        />
      </div>
      {error && <p className="auth-error">{error}</p>}
      <div className="spacer" />
      <div className="bottom-actions">
        <span />
        <button className="btn-advance" onClick={onSend} disabled={busy || !email.trim()}>送る →</button>
      </div>
    </div>
  );
}

/* 0.5: はじめまして（アカウントが空の時だけ・1回きり） */
function WelcomeScreen({ busy, onSeed, onSkip }) {
  return (
    <div className="screen-col">
      <p className="eyebrow">はじめまして</p>
      <h1 className="headline">まだ何もない。</h1>
      <div className="welcome-choices">
        <button className="welcome-btn" onClick={onSeed} disabled={busy}>
          <p className="welcome-btn-title">仮データで試す</p>
          <p className="welcome-btn-sub">目標の例をいくつか入れて、動きを見る</p>
        </button>
        <button className="welcome-btn" onClick={onSkip} disabled={busy}>
          <p className="welcome-btn-title">自分の目標から始める</p>
          <p className="welcome-btn-sub">空の状態で、投げ込みと仕分けから積み上げる</p>
        </button>
      </div>
      <div className="spacer" />
    </div>
  );
}

function VoiceOverlay({ text, sub, duration }) {
  return (
    <div className="voice-overlay" style={{ animationDuration: `${duration || 1400}ms` }}>
      <p className="voice-text">{text}</p>
      {sub && <p className="voice-sub">{sub}</p>}
    </div>
  );
}

/* 01 開幕（栞あり） */
function OpeningBookmark({ goal, step, showHint, graceActive, onContinue, onDifferent }) {
  return (
    <div className="screen-col">
      {graceActive && <div className="grace-line"><div className="grace-fill" /></div>}
      {showHint && <p className="hint-text">そのまま続きに入る</p>}
      <p className="tag-pill">栞 ー つづき</p>
      <p className="goal-line">{goal.title}</p>
      <h1 className="headline">{step.title}</h1>
      <div className="meta-stack">
        {goal.bookmark && goal.bookmark.note && <span>{goal.bookmark.note}</span>}
      </div>
      <div className="spacer" />
      <div className="bottom-actions">
        <button className="btn-plain" onClick={onDifferent}>ちがうことをする</button>
        <button className="btn-advance" onClick={onContinue}>つづける →</button>
      </div>
    </div>
  );
}

/* 02 Focus（工程は出さない。出るのは次の一手ひとつだけ） */
function Focus({ goal, step, elapsedMinutes, onFinish, onAddNote, onEndGoal }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [goalOpen, setGoalOpen] = useState(false);

  const submitNote = () => {
    const t = draft.trim();
    if (t) onAddNote(t);
    setDraft("");
    setEditing(false);
  };

  return (
    <div className="screen-col">
      <div className="focus-top">
        <span>経過 {elapsedMinutes}分</span>
        {goal.bookmark && goal.bookmark.short && <span>栞：{goal.bookmark.short}</span>}
      </div>

      <button className="goal-line-btn" onClick={() => setGoalOpen((v) => !v)}>{goal.title}</button>
      {goalOpen && (
        <div className="end-goal-row">
          <button className="end-goal-btn" onClick={onEndGoal}>この目標を終える</button>
        </div>
      )}

      <p className="eyebrow">次の一手</p>
      <h1 className="headline">{step.title}</h1>

      <div className="spacer" />

      {editing ? (
        <div className="inline-edit">
          <input
            autoFocus
            className="inline-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="いまの進み具合"
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNote();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <button className="btn-plain small" onClick={submitNote}>追記する</button>
        </div>
      ) : (
        <div className="bottom-actions">
          <button className="btn-plain" onClick={() => setEditing(true)}>✎ 栞に追記</button>
          <button className="btn-advance" onClick={onFinish}>ここまで</button>
        </div>
      )}
    </div>
  );
}

/* 一手の締め（工程あり／なしの分岐は無い。次が無ければ書けばそれが工程になる） */
function ClosingPanel({ goal, minutes, nextTitle, draft, setDraft, onProceed, onEndGoal }) {
  return (
    <div className="closing-backdrop" onClick={onProceed}>
      <div className="closing-panel" onClick={(e) => e.stopPropagation()}>
        <p className="voice-text">ひとつ、終わった。</p>
        <p className="voice-sub">この一手に{minutes}分</p>

        {nextTitle ? (
          <p className="closing-next">次 — {nextTitle}</p>
        ) : (
          <div className="closing-field">
            <p className="field-label">次の一手は？（空欄のままでもいい）</p>
            <input
              autoFocus
              className="closing-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onProceed(); }}
            />
          </div>
        )}

        <div className="closing-end">
          <span>{goal.title}、これで終わり？</span>
          <button className="closing-end-btn" onClick={onEndGoal}>終わり</button>
        </div>

        <div className="closing-actions">
          <button className="closing-go" onClick={onProceed}>→</button>
        </div>
      </div>
    </div>
  );
}

/* 候補カード */
function CandidateCard({ entry, onReject, onSelect, splitting, splitDraft, setSplitDraft, onSplitSubmit, onSplitCancel, onSplitStart, onLetGo, onKeepAsIs }) {
  const cardRef = useRef(null);
  const drag = useRef({ active: false, startX: 0, dx: 0 });
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const THRESHOLD = 90;

  const down = (e) => {
    if (splitting) return;
    drag.current = { active: true, startX: e.clientX, dx: 0 };
    setDragging(true);
    try { cardRef.current && cardRef.current.setPointerCapture(e.pointerId); } catch (err) {}
  };
  const move = (e) => {
    if (!drag.current.active) return;
    const d = e.clientX - drag.current.startX;
    drag.current.dx = d;
    setDx(d);
  };
  const up = () => {
    if (!drag.current.active) return;
    const d = drag.current.dx;
    drag.current.active = false;
    setDragging(false);
    setDx(0);
    if (d <= -THRESHOLD) onReject();
    else if (d >= THRESHOLD && entry.kind !== "reconsider") onSelect();
  };

  const style = {
    transform: `translateX(${dx}px) rotate(${dx / 18}deg)`,
    opacity: 1 - Math.min(Math.abs(dx) / 260, 0.5),
    transition: dragging ? "none" : "transform 0.25s ease, opacity 0.25s ease",
  };
  const handlers = { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerLeave: up };

  const splitInput = (
    <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
      <input
        autoFocus
        className="inline-input"
        value={splitDraft}
        onChange={(e) => setSplitDraft(e.target.value)}
        placeholder="もっと小さい一手"
        onKeyDown={(e) => {
          if (e.key === "Enter") onSplitSubmit();
          if (e.key === "Escape") onSplitCancel();
        }}
      />
      <button className="btn-plain small" onClick={onSplitSubmit}>置きかえる</button>
    </div>
  );

  if (entry.kind === "writeout") {
    return (
      <div ref={cardRef} className="candidate-card" style={style} {...handlers}>
        <p className="candidate-text">書き出す</p>
        <p className="candidate-meta">頭にあることを、そのまま投げ込む</p>
      </div>
    );
  }

  if (entry.kind === "reconsider") {
    return (
      <div ref={cardRef} className="candidate-card" style={style} {...handlers}>
        <p className="candidate-text">{entry.goal.title}</p>
        <p className="reconsider-note">{entry.goal.passed_count}回見送った</p>
        {splitting ? splitInput : (
          <div className="reconsider-actions">
            <button className="reconsider-btn" onClick={onSplitStart}>小さく割る</button>
            <button className="reconsider-btn" onClick={onLetGo}>手放す</button>
            <button className="reconsider-btn" onClick={onKeepAsIs}>このままでいい</button>
          </div>
        )}
      </div>
    );
  }

  const { goal, step, mark, suggestSplit } = entry;
  const tagClass = mark === "本命" ? "candidate-tag accent" : "candidate-tag";
  return (
    <div ref={cardRef} className="candidate-card" style={style} {...handlers}>
      {mark && <span className={tagClass}>{mark}</span>}
      <p className="candidate-text">{step.title}</p>
      <p className="candidate-meta">{goal.title}</p>
      {suggestSplit && !splitting && (
        <div className="split-hint">
          <p className="split-hint-note">今日は軽いものがない。</p>
          <button className="split-hint-btn" onClick={onSplitStart}>これを割ってみる？</button>
        </div>
      )}
      {suggestSplit && splitting && splitInput}
    </div>
  );
}

/* 03 調子 → 候補 */
function ToneCandidates({
  tone, candidates, index, onSelectTone, onReject, onSelect, onNone, onShelf, onRest,
  splitting, splitDraft, setSplitDraft, onSplitStart, onSplitSubmit, onSplitCancel, onLetGo, onKeepAsIs,
}) {
  const current = candidates[index];
  const isReconsider = current && current.kind === "reconsider";

  return (
    <div className="screen-col">
      <p className="eyebrow">いまの調子</p>
      <div className="tone-grid">
        {TONES.map((t) => (
          <button key={t} className={`tone-btn ${tone === t ? "selected" : ""}`} onClick={() => onSelectTone(t)}>
            {t}
          </button>
        ))}
      </div>

      {current ? (
        <>
          <div className="counter-row">
            <span className="eyebrow">候補</span>
            <span className="counter-label">{kanji(index + 1)}／{kanji(candidates.length)}</span>
          </div>
          <CandidateCard
            key={`${tone}-${current.id}`}
            entry={current}
            onReject={onReject}
            onSelect={() => onSelect(current)}
            splitting={splitting}
            splitDraft={splitDraft}
            setSplitDraft={setSplitDraft}
            onSplitStart={onSplitStart}
            onSplitSubmit={onSplitSubmit}
            onSplitCancel={onSplitCancel}
            onLetGo={onLetGo}
            onKeepAsIs={onKeepAsIs}
          />
          <div className="bottom-actions">
            <button className="btn-plain" onClick={onReject}>← ちがう</button>
            {!isReconsider && (
              <button className="btn-advance" onClick={() => onSelect(current)}>
                {current.kind === "writeout" ? "書き出す →" : "これをやる →"}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="empty-note">{tone ? "いま出せる一手はない。" : "調子を選ぶと、候補が出る。"}</p>
          <div className="spacer" />
        </>
      )}

      <div className="rest-row">
        <button className="btn-muted" onClick={onNone}>いまはどれも違う</button>
        <button className="btn-muted" onClick={onShelf}>いま抱えているもの</button>
        <button className="btn-muted" onClick={onRest}>休む</button>
      </div>
    </div>
  );
}

/* 06 開幕（栞なし） */
function OpeningNoBookmark({ onSelectTone, onShelf, onRest }) {
  return (
    <div className="screen-col">
      <p className="eyebrow">いまの調子</p>
      <div className="tone-grid">
        {TONES.map((t) => (
          <button key={t} className="tone-btn" onClick={() => onSelectTone(t)}>{t}</button>
        ))}
      </div>
      <div className="spacer" />
      <div className="rest-row">
        <button className="btn-muted" onClick={onShelf}>いま抱えているもの</button>
        <button className="btn-muted" onClick={onRest}>休む</button>
      </div>
    </div>
  );
}

/* いま抱えているもの（読む場所。畳んだ塊はすべて開く） */
function Shelf({ goals, unsortedCount, onClose, onOpenGoal, onStartSorting, onWake, onDeleteDone }) {
  const [open, setOpen] = useState(null);
  const live = goals.filter(isLive);
  const sleeping = goals.filter((g) => g.status === "寝かせ");
  const finished = goals.filter((g) => g.status === "完了");

  return (
    <div className="screen-col">
      <p className="eyebrow">いま抱えているもの</p>

      <div className="shelf-scroll">
        {live.map((g) => {
          const last = g.steps_done.length > 0 ? g.steps_done[g.steps_done.length - 1] : null;
          const next = nextStepOf(g);
          const prog = progressOf(g);
          return (
            <div className="goal-row" key={g.id}>
              <div className="goal-head">
                <button className="goal-title-btn" onClick={() => onOpenGoal(g.id)}>{g.title}</button>
                <span className="goal-cat">{g.category}</span>
              </div>
              {last ? (
                <p className="goal-line-row"><span className="lead">{relativeDay(last.at)} — </span>{last.title}</p>
              ) : (
                <p className="goal-line-row">まだ始めていない</p>
              )}
              {next && <p className="goal-line-row next"><span className="lead">次 — </span>{next.title}</p>}
              {prog && (
                <div className="progress-wrap">
                  <div className="progress-bar"><div className="progress-fill" style={{ width: `${prog.ratio * 100}%` }} /></div>
                  <span className="progress-label">{prog.label}</span>
                </div>
              )}
            </div>
          );
        })}

        <div className="shelf-block">
          <button className="shelf-block-btn" onClick={onStartSorting}>
            <span>まだ仕分けていないもの</span>
            <span className="n">{unsortedCount}</span>
          </button>
        </div>

        {sleeping.length > 0 && (
          <div className="shelf-block">
            <button className="shelf-block-btn" onClick={() => setOpen(open === "sleeping" ? null : "sleeping")}>
              <span>寝かせているもの</span>
              <span className="n">{sleeping.length}</span>
            </button>
            {open === "sleeping" && (
              <ul className="folded-list">
                {sleeping.map((g) => (
                  <li className="folded-item" key={g.id}>
                    <button className="name" onClick={() => onOpenGoal(g.id)}>{g.title}</button>
                    <button className="mini-btn" onClick={() => onWake(g.id)}>戻す</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {finished.length > 0 && (
          <div className="shelf-block">
            <button className="shelf-block-btn" onClick={() => setOpen(open === "done" ? null : "done")}>
              <span>終わったもの</span>
              <span className="n">{finished.length}</span>
            </button>
            {open === "done" && (
              <ul className="folded-list">
                {finished.map((g) => (
                  <li className="folded-item" key={g.id}>
                    <button className="name" onClick={() => onOpenGoal(g.id)}>{g.title}</button>
                    <span className="folded-when">{g.completed_at ? relativeDay(g.completed_at) : ""}</span>
                    <button className="mini-btn" onClick={() => onDeleteDone(g.id)}>消す</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="rest-row solo">
        <button className="btn-plain" onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

/* 目標の詳細（ここだけが編集できる部屋） */
function GoalDetail({
  goal, onClose, onSetHeadStep, onAddStep, onAddStepAtHead, onDeleteStep, onMoveStep,
  onPromoteStep, onSetCapacity, onSetFelt, onToggleImportant, onSetCategory, onSleep, onComplete,
}) {
  const [editingNext, setEditingNext] = useState(false);
  const [nextDraft, setNextDraft] = useState("");
  const [stepDraft, setStepDraft] = useState("");
  const [headDraft, setHeadDraft] = useState("");
  const [addingHead, setAddingHead] = useState(false);
  const [feltDraft, setFeltDraft] = useState(goal.felt_progress == null ? "" : String(goal.felt_progress));

  const next = nextStepOf(goal);
  const history = goal.steps_done.slice().reverse();
  const total = totalMinutes(goal);
  const steps = goal.process_steps || [];
  const done = steps.filter((s) => s.done).length;
  const isDoneGoal = goal.status === "完了";
  const prog = progressOf(goal);

  /* 工程の並び替え：入れ替え前の位置を測り、差分から滑らせる */
  const stepListRef = useRef(null);
  const rowRefs = useRef(new Map());
  const beforeTops = useRef(null);
  const [pressed, setPressed] = useState(null);

  const handleMoveStep = (sid, dir) => {
    const tops = new Map();
    rowRefs.current.forEach((el, id) => { if (el) tops.set(id, el.getBoundingClientRect().top); });
    beforeTops.current = tops;
    setPressed({ id: sid, dir, nonce: Date.now() });
    onMoveStep(sid, dir);
  };

  useLayoutEffect(() => {
    const tops = beforeTops.current;
    if (!tops) return;
    beforeTops.current = null;

    const still =
      typeof window !== "undefined" && window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!still) {
      rowRefs.current.forEach((el, id) => {
        if (!el) return;
        const before = tops.get(id);
        if (before == null) return;
        const delta = before - el.getBoundingClientRect().top;
        if (!delta) return;
        el.style.transition = "none";
        el.style.transform = `translateY(${delta}px)`;
        el.style.zIndex = "2";
        requestAnimationFrame(() => {
          el.style.transition = "transform 260ms cubic-bezier(0.22, 0.61, 0.36, 1)";
          el.style.transform = "";
          window.setTimeout(() => { el.style.transition = ""; el.style.zIndex = ""; }, 300);
        });
      });
    }

    if (pressed && stepListRef.current) {
      const btn = stepListRef.current.querySelector(`[data-arrow="${pressed.id}:${pressed.dir}"]`);
      if (btn && !btn.disabled) btn.focus({ preventScroll: true });
      else if (document.activeElement && document.activeElement.disabled) document.activeElement.blur();
    }
  }, [steps, pressed]);

  useEffect(() => {
    if (!pressed) return;
    const t = setTimeout(() => setPressed(null), 320);
    return () => clearTimeout(t);
  }, [pressed]);

  const arrowClass = (sid, dir) =>
    `step-arrow${pressed && pressed.id === sid && pressed.dir === dir ? " pressed" : ""}`;

  const commitNext = () => {
    const t = nextDraft.trim();
    if (t) onSetHeadStep(t);
    setEditingNext(false);
  };

  return (
    <div className="screen-col">
      <p className="detail-title">{goal.title}</p>
      <p className="detail-sum">これまで {formatDuration(total)} ／ {goal.steps_done.length}手</p>

      <div className="detail-scroll">
        {!isDoneGoal && (
          <div className="detail-section">
            <p className="eyebrow">次の一手</p>
            {editingNext ? (
              <div className="row-line">
                <input
                  autoFocus
                  className="inline-input"
                  value={nextDraft}
                  onChange={(e) => setNextDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitNext();
                    if (e.key === "Escape") setEditingNext(false);
                  }}
                />
                <button className="mini-btn" onClick={commitNext}>置く</button>
              </div>
            ) : (
              <button
                className={`next-now ${next ? "" : "empty"}`}
                onClick={() => { setNextDraft(next ? next.title : ""); setEditingNext(true); }}
              >
                {next ? next.title : "まだ決めていない"}
              </button>
            )}
          </div>
        )}

        {history.length > 0 && (
          <div className="detail-section">
            <p className="eyebrow">終えた一手</p>
            {history.map((h, i) => (
              <div className="history-item" key={i}>
                <span>{relativeDay(h.at)}</span>
                <span className="t">{h.title}</span>
                <span>{h.minutes ? `${h.minutes}分` : ""}</span>
              </div>
            ))}
          </div>
        )}

        <div className="detail-section" ref={stepListRef}>
          <p className="eyebrow">工程</p>
          {steps.length === 0 && <p className="goal-line-row">まだ無い。終えるたびに1つずつ書いてもいい。</p>}
          {steps.map((s, i) => {
            const isHead = !s.done && next && s.id === next.id;
            return (
              <div
                className="row-line step-row"
                key={s.id}
                ref={(el) => { if (el) rowRefs.current.set(s.id, el); else rowRefs.current.delete(s.id); }}
              >
                <span className={`grow ${s.done ? "step-done" : ""} ${isDoneGoal && !s.done ? "step-left" : ""}`}>
                  {s.title}
                </span>
                {isHead && <span className="step-head-mark">次</span>}
                {!isDoneGoal && (
                  <>
                    <button
                      className={arrowClass(s.id, -1)} data-arrow={`${s.id}:-1`}
                      onClick={() => handleMoveStep(s.id, -1)} disabled={i === 0} aria-label="上へ"
                    >↑</button>
                    <button
                      className={arrowClass(s.id, 1)} data-arrow={`${s.id}:1`}
                      onClick={() => handleMoveStep(s.id, 1)} disabled={i === steps.length - 1} aria-label="下へ"
                    >↓</button>
                    <button className="mini-btn" onClick={() => onPromoteStep(s.id)}>独立</button>
                    <button className="mini-btn" onClick={() => onDeleteStep(s.id)} aria-label="消す">×</button>
                  </>
                )}
              </div>
            );
          })}

          {!isDoneGoal && (
            <>
              {addingHead ? (
                <div className="row-line">
                  <input
                    autoFocus
                    className="inline-input"
                    value={headDraft}
                    onChange={(e) => setHeadDraft(e.target.value)}
                    placeholder="その前にやること"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && headDraft.trim()) { onAddStepAtHead(headDraft); setHeadDraft(""); setAddingHead(false); }
                      if (e.key === "Escape") { setAddingHead(false); setHeadDraft(""); }
                    }}
                  />
                  <button
                    className="mini-btn"
                    onClick={() => { if (headDraft.trim()) { onAddStepAtHead(headDraft); setHeadDraft(""); setAddingHead(false); } }}
                  >入れる</button>
                </div>
              ) : (
                <div className="chip-row" style={{ marginTop: 8 }}>
                  <button className="mini-btn" onClick={() => setAddingHead(true)}>先頭に足す</button>
                </div>
              )}

              <div className="row-line">
                <input
                  className="inline-input"
                  value={stepDraft}
                  onChange={(e) => setStepDraft(e.target.value)}
                  placeholder="工程を足す"
                  onKeyDown={(e) => { if (e.key === "Enter" && stepDraft.trim()) { onAddStep(stepDraft); setStepDraft(""); } }}
                />
                <button className="mini-btn" onClick={() => { if (stepDraft.trim()) { onAddStep(stepDraft); setStepDraft(""); } }}>足す</button>
              </div>
            </>
          )}
        </div>

        {!isDoneGoal && (
          <div className="detail-section">
            <p className="eyebrow">進み具合</p>
            {prog && prog.kind === "felt" && <p className="pct-main">{prog.label}</p>}
            <div className="row-line">
              <input
                className="inline-input pct-input"
                inputMode="numeric"
                value={feltDraft}
                onChange={(e) => setFeltDraft(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="体感"
                onKeyDown={(e) => { if (e.key === "Enter") onSetFelt(feltDraft); }}
              />
              <span className="goal-line-row">%</span>
              <button className="mini-btn" onClick={() => onSetFelt(feltDraft)}>置く</button>
              <button className="mini-btn" onClick={() => { setFeltDraft(""); onSetFelt(""); }}>消す</button>
            </div>
            {hasProcess(goal) && <p className="pct-sub">工程では {done}／{steps.length}</p>}
          </div>
        )}

        {!isDoneGoal && (
          <div className="detail-section">
            <p className="eyebrow">エネルギー</p>
            <p className="capacity-note">{CAPACITY_NOTE}</p>
            <div className="capacity-row">
              {CAPACITIES.map((c) => (
                <button
                  key={c}
                  className={`capacity-btn ${(goal.capacity || DEFAULT_CAPACITY) === c ? "selected" : ""}`}
                  onClick={() => onSetCapacity(c)}
                >{c}</button>
              ))}
            </div>
          </div>
        )}

        {!isDoneGoal && (
          <div className="detail-section">
            <p className="eyebrow">属性</p>
            <div className="chip-row">
              {CATEGORIES.map((c) => (
                <button key={c} className={`mini-btn ${goal.category === c ? "on" : ""}`} onClick={() => onSetCategory(c)}>{c}</button>
              ))}
            </div>
            <div className="chip-row" style={{ marginTop: 8 }}>
              <button className={`mini-btn ${goal.important_flag ? "on" : ""}`} onClick={onToggleImportant}>本命</button>
            </div>
          </div>
        )}

        {!isDoneGoal && (
          <div className="detail-section">
            <div className="detail-end">
              <button className="end-btn" onClick={onComplete}>この目標を終える</button>
            </div>
            <div className="detail-sleep">
              <button className="sleep-btn" onClick={onSleep}>
                {goal.status === "寝かせ" ? "起こす" : "しばらく寝かせる"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="rest-row solo">
        <button className="btn-plain" onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

/* 仕分け（全件を一覧で。どれから手を付けてもいい） */
function Sorting({ items, onMakeGoal, onDrop, onClose }) {
  const [formFor, setFormFor] = useState(null);
  const [title, setTitle] = useState("");
  const [action, setAction] = useState("");
  const [category, setCategory] = useState(null);
  const [capacity, setCapacity] = useState(DEFAULT_CAPACITY);

  const startForm = (item) => {
    setFormFor(item);
    setTitle(item.text);
    setAction("");
    setCategory(null);
    setCapacity(DEFAULT_CAPACITY);
  };

  if (formFor) {
    return (
      <div className="screen-col">
        <p className="eyebrow">目標にする</p>
        <div className="sort-form" style={{ marginTop: 14 }}>
          <div>
            <p className="field-label">目標</p>
            <input className="inline-input wide" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <p className="field-label">次の一手</p>
            <input
              className="inline-input wide"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && title.trim()) { onMakeGoal(formFor, title, action, category, capacity); setFormFor(null); } }}
            />
          </div>
          <div>
            <p className="field-label">エネルギー</p>
            <p className="capacity-note">{CAPACITY_NOTE}</p>
            <div className="capacity-row">
              {CAPACITIES.map((c) => (
                <button
                  key={c}
                  className={`capacity-btn ${capacity === c ? "selected" : ""}`}
                  onClick={() => setCapacity(c)}
                >{c}</button>
              ))}
            </div>
          </div>
          <div>
            <p className="field-label">カテゴリ（無くてもいい）</p>
            <div className="chip-row">
              {CATEGORIES.map((c) => (
                <button key={c} className={`mini-btn ${category === c ? "on" : ""}`} onClick={() => setCategory(category === c ? null : c)}>{c}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="spacer" />
        <div className="bottom-actions">
          <button className="btn-plain" onClick={() => setFormFor(null)}>← もどる</button>
          <button
            className="btn-advance"
            disabled={!title.trim()}
            onClick={() => { onMakeGoal(formFor, title, action, category, capacity); setFormFor(null); }}
          >目標にする →</button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen-col">
      <p className="eyebrow">まだ仕分けていないもの</p>

      <div className="sort-scroll">
        {items.length === 0 && <p className="empty-note">ここは空になっている。</p>}
        {items.map((item) => (
          <div className="sort-row" key={item.id}>
            <p className="sort-row-text">{item.text}</p>
            <div className="sort-row-actions">
              <button className="mini-btn" onClick={() => startForm(item)}>目標にする</button>
              <button className="mini-btn" onClick={() => onDrop(item)}>手放す</button>
            </div>
          </div>
        ))}
      </div>

      <div className="rest-row solo">
        <button className="btn-plain" onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

/* 04 浮遊キャプチャ */
function CaptureSheet({ text, setText, onSubmit, onCancel, listening, speechSupported, onToggleListen }) {
  return (
    <div className="capture-backdrop" onClick={onCancel}>
      <div className="capture-sheet" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow">投げ込み</p>
        <textarea
          autoFocus
          aria-label="投げ込む内容"
          className="capture-input"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="capture-actions">
          <button
            className={`btn-plain small ${listening ? "listening" : ""}`}
            onClick={onToggleListen}
            disabled={!speechSupported}
            title={speechSupported ? "声で入れる" : "この環境では使えない"}
          >
            {listening ? "● 聞いています" : "声で"}
          </button>
          <button className="btn-advance" onClick={onSubmit} disabled={!text.trim()}>投げ込む</button>
        </div>
      </div>
    </div>
  );
}

function BottomCaptureHandle({ onOpen }) {
  const drag = useRef({ active: false, startY: 0, dy: 0 });
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const THRESHOLD = 34;

  const down = (e) => { drag.current = { active: true, startY: e.clientY, dy: 0 }; setDragging(true); };
  const move = (e) => {
    if (!drag.current.active) return;
    const d = Math.min(0, e.clientY - drag.current.startY);
    drag.current.dy = d; setDy(d);
  };
  const up = () => {
    if (!drag.current.active) return;
    const d = drag.current.dy;
    drag.current.active = false; setDragging(false); setDy(0);
    if (d <= -THRESHOLD || Math.abs(d) < 6) onOpen();
  };

  return (
    <div
      className="bottom-handle-zone"
      role="button"
      aria-label="下に引いて投げ込む"
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerLeave={up}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpen(); }}
    >
      <div className="bottom-handle" style={{ transform: `translateY(${dy}px)`, transition: dragging ? "none" : "transform 0.2s ease" }} />
    </div>
  );
}

/* ------------------------------ 本体 ------------------------------ */

export default function HormeApp() {
  const [goals, setGoals] = useState([]);
  const [captures, setCaptures] = useState([]);

  const [screen, setScreen] = useState("loading");
  const [shelfReturn, setShelfReturn] = useState("opening-no-bookmark");
  const [detailGoalId, setDetailGoalId] = useState(null);
  const [activeGoalId, setActiveGoalId] = useState(null);

  const [tone, setTone] = useState(null);
  const [excludeIds, setExcludeIds] = useState([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [lastHonmeiGoalId, setLastHonmeiGoalId] = useState(null);
  const [sortCount, setSortCount] = useState(0);
  const [ignoreCooldown, setIgnoreCooldown] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);

  const [splitting, setSplitting] = useState(false);
  const [splitDraft, setSplitDraft] = useState("");

  const [sessionStart, setSessionStart] = useState(null);
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  const [devOffsetMs, setDevOffsetMs] = useState(0);

  const [closing, setClosing] = useState(null);
  const [closingDraft, setClosingDraft] = useState("");

  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [voice, setVoice] = useState(null);

  const [seenHint, setSeenHint] = useState(false);
  const [graceActive, setGraceActive] = useState(false);
  const [clock, setClock] = useState(() => formatClock(new Date()));
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);

  /* ---- 0.5: 認証・データの読み込みと同期 ---- */
  const [session, setSession] = useState(null);
  const [authScreen, setAuthScreen] = useState("email"); // 'email' | 'code'
  const [authEmail, setAuthEmail] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [authError, setAuthError] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [dataReady, setDataReady] = useState(false);
  const [syncError, setSyncError] = useState(null);

  const sessionRef = useRef(null);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // 直前に同期した内容。参照が変わっていれば「変更があった」とみなす（値の中身は見ない）。
  // このアプリの更新は一貫してイミュータブルなので、参照比較だけで安全に差分が取れる。
  const prevGoalsRef = useRef(null);
  const prevCapturesRef = useRef(null);

  const recognitionRef = useRef(null);
  const voiceTimer = useRef(null);
  const goalsRef = useRef(goals);
  useEffect(() => { goalsRef.current = goals; }, [goals]);

  const goalById = useMemo(() => Object.fromEntries(goals.map((g) => [g.id, g])), [goals]);
  const activeGoal = activeGoalId ? goalById[activeGoalId] : null;
  const activeStep = activeGoal ? nextStepOf(activeGoal) : null;
  const bookmarkedGoal = goals.find((g) => isLive(g) && g.bookmark && nextStepOf(g)) || null;
  const unsorted = captures.filter((c) => c.status === "unsorted");

  /* ---- 0.5: 起動時にセッションを復元する ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadSession();
      if (!saved) { if (!cancelled) setScreen("auth"); return; }
      let s = saved;
      if (s.expiresAt - Date.now() < 5 * 60 * 1000) {
        try {
          s = sessionFromAuthResponse(await Auth.refresh(s.refreshToken));
          await saveSession(s);
        } catch (err) {
          await clearSession();
          if (!cancelled) setScreen("auth");
          return;
        }
      }
      if (!cancelled) setSession(s);
    })();
    return () => { cancelled = true; };
  }, []);

  /* セッションが立ったら目標・捕獲を読み込む。空アカウントなら「はじめまして」へ。 */
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const [g, c] = await Promise.all([Data.goals.list(session.accessToken), Data.inbox.list(session.accessToken)]);
        if (cancelled) return;
        prevGoalsRef.current = g;
        prevCapturesRef.current = c;
        setGoals(g);
        setCaptures(c);
        setDataReady(true);
        setScreen(g.length === 0 && c.length === 0 ? "welcome" : "opening-bookmark");
      } catch (err) {
        if (!cancelled) setSyncError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [session]);

  /* トークンの寿命が切れる前に、静かに更新し続ける */
  useEffect(() => {
    if (!session) return;
    const wait = Math.max(5000, session.expiresAt - Date.now() - 5 * 60 * 1000);
    const t = setTimeout(async () => {
      try {
        const next = sessionFromAuthResponse(await Auth.refresh(session.refreshToken));
        await saveSession(next);
        setSession(next);
      } catch (err) {
        await clearSession();
        setSession(null);
        setDataReady(false);
        setGoals([]); setCaptures([]);
        prevGoalsRef.current = null; prevCapturesRef.current = null;
        setScreen("auth");
      }
    }, wait);
    return () => clearTimeout(t);
  }, [session]);

  /* goals の変更をSupabaseへ反映する。イミュータブル更新なので参照比較だけで差分がわかる。 */
  useEffect(() => {
    if (!dataReady || !session) return;
    const prev = prevGoalsRef.current;
    if (prev === null || prev === goals) { prevGoalsRef.current = goals; return; }
    prevGoalsRef.current = goals;
    const token = session.accessToken;
    const prevById = new Map(prev.map((g) => [g.id, g]));
    const currIds = new Set(goals.map((g) => g.id));
    for (const g of prev) {
      if (!currIds.has(g.id)) {
        Data.goals.remove(g.id, token).then(() => setSyncError(null)).catch((e) => setSyncError(e.message));
      }
    }
    for (const g of goals) {
      const before = prevById.get(g.id);
      if (!before) {
        Data.goals.insert(g, token).then(() => setSyncError(null)).catch((e) => setSyncError(e.message));
      } else if (before !== g) {
        Data.goals.update(g.id, g, token).then(() => setSyncError(null)).catch((e) => setSyncError(e.message));
      }
    }
  }, [goals, dataReady, session]);

  /* captures（未仕分けの捕獲）も同様。仕分けで解決したものは配列から取り除いているので、
     ここでの「消えた」は常に「行を物理削除してよい」に対応する。 */
  useEffect(() => {
    if (!dataReady || !session) return;
    const prev = prevCapturesRef.current;
    if (prev === null || prev === captures) { prevCapturesRef.current = captures; return; }
    prevCapturesRef.current = captures;
    const token = session.accessToken;
    const prevById = new Map(prev.map((c) => [c.id, c]));
    const currIds = new Set(captures.map((c) => c.id));
    for (const c of prev) {
      if (!currIds.has(c.id)) {
        Data.inbox.remove(c.id, token).then(() => setSyncError(null)).catch((e) => setSyncError(e.message));
      }
    }
    for (const c of captures) {
      if (!prevById.has(c.id)) {
        Data.inbox.insert(c, token).then(() => setSyncError(null)).catch((e) => setSyncError(e.message));
      }
    }
  }, [captures, dataReady, session]);

  /* 認証まわりの操作 */
  const handleSendCode = useCallback(async () => {
    const email = authEmail.trim();
    if (!email) return;
    setAuthBusy(true); setAuthError(null);
    try {
      await Auth.sendCode(email);
      setAuthScreen("code");
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthBusy(false);
    }
  }, [authEmail]);

  const handleVerifyCode = useCallback(async () => {
    const code = authCode.trim();
    if (!code) return;
    setAuthBusy(true); setAuthError(null);
    try {
      const s = sessionFromAuthResponse(await Auth.verifyCode(authEmail.trim(), code));
      if (!s) throw new Error("うまく確認できなかった。");
      await saveSession(s);
      setSession(s);
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthBusy(false);
    }
  }, [authEmail, authCode]);

  const handleResendCode = useCallback(() => { setAuthCode(""); setAuthError(null); handleSendCode(); }, [handleSendCode]);
  const handleBackToEmail = useCallback(() => { setAuthScreen("email"); setAuthCode(""); setAuthError(null); }, []);

  const handleLogout = useCallback(async () => {
    const token = sessionRef.current && sessionRef.current.accessToken;
    if (token) Auth.logout(token);
    await clearSession();
    prevGoalsRef.current = null; prevCapturesRef.current = null;
    setSession(null);
    setDataReady(false);
    setGoals([]); setCaptures([]);
    setAuthScreen("email"); setAuthEmail(""); setAuthCode(""); setAuthError(null);
    setScreen("auth");
  }, []);

  /* 初回のみ：仮データを入れるかどうかを選べる */
  const seedAccount = useCallback(async () => {
    const token = sessionRef.current && sessionRef.current.accessToken;
    if (!token) return;
    setWelcomeBusy(true);
    try {
      const freshGoals = SEED_GOALS.map((g) => ({ ...g, id: newId() }));
      const freshCaptures = SEED_CAPTURES.map((c) => ({ ...c, id: newId() }));
      const insertedGoals = await Promise.all(freshGoals.map((g) => Data.goals.insert(g, token)));
      const insertedCaptures = await Promise.all(freshCaptures.map((c) => Data.inbox.insert(c, token)));
      prevGoalsRef.current = insertedGoals;
      prevCapturesRef.current = insertedCaptures;
      setGoals(insertedGoals);
      setCaptures(insertedCaptures);
      setScreen("opening-bookmark");
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setWelcomeBusy(false);
    }
  }, []);

  const skipSeed = useCallback(() => { setScreen("opening-no-bookmark"); }, []);

  const candidates = useMemo(() => {
    if (!tone) return [];
    return selectCandidates({ tone, goals, excludeIds, lastHonmeiGoalId, sortCount, ignoreCooldown });
  }, [tone, goals, excludeIds, lastHonmeiGoalId, sortCount, ignoreCooldown]);

  // 本命枠のローテーション用。再描画を起こさない ref に置き、回の境界でだけ状態へ移す。
  const shownHonmeiRef = useRef(null);
  useEffect(() => {
    const h = candidates.find((c) => c.mark === "本命" || c.kind === "reconsider");
    if (h && h.goal) shownHonmeiRef.current = h.goal.id;
  }, [candidates]);

  useEffect(() => {
    const id = setInterval(() => setClock(formatClock(new Date())), 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (screen !== "focus" || !sessionStart) return;
    const tick = () => setElapsedMinutes(Math.floor((Date.now() - sessionStart + devOffsetMs) / 60000));
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, [screen, sessionStart, devOffsetMs]);

  /* 声は不可逆な変化にだけ出す */
  const showVoice = useCallback((text, sub, duration, after) => {
    if (voiceTimer.current) clearTimeout(voiceTimer.current);
    setVoice({ text, sub, duration });
    voiceTimer.current = setTimeout(() => {
      setVoice(null);
      if (after) after();
    }, duration);
  }, []);
  useEffect(() => () => { if (voiceTimer.current) clearTimeout(voiceTimer.current); }, []);

  useEffect(() => {
    if (screen !== "opening-bookmark") { setGraceActive(false); return; }
    setGraceActive(false);
    showVoice("おかえり。栞はここにある。", null, 1400, () => setGraceActive(true));
  }, [screen, showVoice]);

  const startSession = useCallback((goalId) => {
    // 始めた一手を栞に控える。終えずに離れたら、これが「つづき」の根拠になる。
    setGoals((gs) =>
      gs.map((g) => {
        if (g.id !== goalId) return g;
        const head = nextStepOf(g);
        return { ...g, bookmark: { ...(g.bookmark || { note: "", short: "" }), started_step_id: head ? head.id : null } };
      })
    );
    setActiveGoalId(goalId);
    setSessionStart(Date.now());
    setDevOffsetMs(0);
    setElapsedMinutes(0);
    setScreen("focus");
  }, []);

  useEffect(() => {
    if (!graceActive) return;
    const t = setTimeout(() => { if (bookmarkedGoal) startSession(bookmarkedGoal.id); }, 10000);
    return () => clearTimeout(t);
  }, [graceActive, bookmarkedGoal, startSession]);

  useEffect(() => {
    const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) { setSpeechSupported(false); return; }
    try {
      const r = new SR();
      r.lang = "ja-JP";
      r.continuous = false;
      r.interimResults = true;
      r.onresult = (e) => {
        let t = "";
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        setCaptureText(t);
      };
      r.onend = () => setListening(false);
      r.onerror = () => setListening(false);
      recognitionRef.current = r;
    } catch (err) { setSpeechSupported(false); }
  }, []);

  const toggleListening = useCallback(() => {
    if (!speechSupported || !recognitionRef.current) return;
    if (listening) { recognitionRef.current.stop(); setListening(false); }
    else {
      setCaptureText("");
      try { recognitionRef.current.start(); setListening(true); } catch (err) {}
    }
  }, [listening, speechSupported]);

  /* ---- 遷移 ---- */

  const handleContinue = useCallback(() => {
    setSeenHint(true);
    if (bookmarkedGoal) startSession(bookmarkedGoal.id);
  }, [bookmarkedGoal, startSession]);

  const handleDifferent = useCallback(() => {
    setSeenHint(true);
    setTone(null); setExcludeIds([]); setCandidateIndex(0); setSplitting(false);
    setScreen("tone");
  }, []);

  const handleSelectTone = useCallback((t) => {
    setLastHonmeiGoalId(shownHonmeiRef.current);
    setTone(t);
    setExcludeIds([]);
    setCandidateIndex(0);
    setSplitting(false);
    setSortCount((c) => c + 1);
    setScreen("tone");
    if (t === "低調") showVoice("今日は小さく。", null, 1400, null);
  }, [showVoice]);

  // 候補を1枚送るのは何も手放していない。無言で次へ。
  const handleReject = useCallback(() => {
    const current = candidates[candidateIndex];
    if (current && current.kind === "task" && current.mark === "本命") {
      const gid = current.goal.id;
      const now = Date.now();
      setGoals((gs) => gs.map((g) => (g.id === gid ? { ...g, passed_count: g.passed_count + 1, last_passed_at: now } : g)));
    }
    setSplitting(false);
    setCandidateIndex((i) => (candidates.length ? (i + 1) % candidates.length : 0));
  }, [candidates, candidateIndex]);

  const handleSelectCandidate = useCallback((entry) => {
    if (entry.kind === "writeout") { setCaptureOpen(true); setCaptureText(""); return; }
    if (entry.kind !== "task") return;
    const now = Date.now();
    setGoals((gs) =>
      withSingleBookmark(gs, entry.goal.id, null).map((g) =>
        g.id === entry.goal.id ? { ...g, status: "進行中", last_touched_at: now, updated_at: now } : g
      )
    );
    setTone(null); setExcludeIds([]); setCandidateIndex(0);
    startSession(entry.goal.id);
  }, [startSession]);

  const handleNone = useCallback(() => {
    setLastHonmeiGoalId(shownHonmeiRef.current);
    setExcludeIds((ids) => [...ids, ...candidates.filter((c) => c.goal).map((c) => c.goal.id)]);
    setCandidateIndex(0);
    setSplitting(false);
  }, [candidates]);

  /* 小さく割る（見送り三択・低調の促し、どちらも同じ仕組み） */
  const handleSplitStart = useCallback(() => {
    const current = candidates[candidateIndex];
    setSplitDraft(current && current.step ? current.step.title : "");
    setSplitting(true);
  }, [candidates, candidateIndex]);

  const handleSplitCancel = useCallback(() => { setSplitting(false); setSplitDraft(""); }, []);

  const handleSplitSubmit = useCallback(() => {
    const current = candidates[candidateIndex];
    const text = splitDraft.trim();
    if (!current || !current.step || !text) { setSplitting(false); return; }
    const gid = current.goal.id;
    const sid = current.step.id;
    setGoals((gs) =>
      gs.map((g) =>
        g.id === gid
          ? {
              ...g,
              process_steps: g.process_steps.map((s) => (s.id === sid ? { ...s, title: text } : s)),
              passed_count: 0, last_passed_at: null,
            }
          : g
      )
    );
    setSplitting(false); setSplitDraft("");
  }, [candidates, candidateIndex, splitDraft]);

  const handleLetGo = useCallback(() => {
    const current = candidates[candidateIndex];
    if (!current) return;
    const gid = current.goal.id;
    setGoals((gs) => gs.map((g) => (g.id === gid ? { ...g, status: "寝かせ", bookmark: null, passed_count: 0, last_passed_at: null, updated_at: Date.now() } : g)));
    setSplitting(false); setCandidateIndex(0);
    showVoice("手放した。", null, 1100, null);
  }, [candidates, candidateIndex, showVoice]);

  const handleKeepAsIs = useCallback(() => {
    const current = candidates[candidateIndex];
    if (!current) return;
    const gid = current.goal.id;
    setGoals((gs) => gs.map((g) => (g.id === gid ? { ...g, passed_count: 0, last_passed_at: null } : g)));
    setSplitting(false); setCandidateIndex(0);
  }, [candidates, candidateIndex]);

  const handleAddNote = useCallback((text) => {
    setGoals((gs) =>
      gs.map((g) =>
        g.id === activeGoalId
          ? { ...g, bookmark: { note: g.bookmark && g.bookmark.note ? `${g.bookmark.note} ${text}` : text, short: text }, updated_at: Date.now() }
          : g
      )
    );
  }, [activeGoalId]);

  /* 「ここまで」＝工程の先頭を済みにし、所要分を記録して締めの一画面へ */
  const handleFinish = useCallback(() => {
    const goal = goalsRef.current.find((g) => g.id === activeGoalId);
    if (!goal) return;
    const step = nextStepOf(goal);
    if (!step) return;
    const minutes = sessionStart ? Math.floor((Date.now() - sessionStart + devOffsetMs) / 60000) : 0;
    const now = Date.now();

    const updatedSteps = goal.process_steps.map((s) => (s.id === step.id ? { ...s, done: true } : s));
    const nextStep = updatedSteps.find((s) => !s.done);

    setGoals((gs) =>
      gs.map((g) =>
        g.id === goal.id
          ? {
              ...g,
              status: "進行中",
              process_steps: updatedSteps,
              steps_done: [...g.steps_done, { title: step.title, at: now, minutes }],
              bookmark: nextStep ? { note: "", short: "", started_step_id: null } : null,
              last_touched_at: now,
              updated_at: now,
            }
          : g
      )
    );

    setSessionStart(null);
    setClosingDraft("");
    setClosing({ goalId: goal.id, minutes, nextTitle: nextStep ? nextStep.title : null });
  }, [activeGoalId, sessionStart, devOffsetMs]);

  /* 締めの一画面 → 静かに調子画面へ。書いた一手はそのまま工程になる。 */
  const proceedFromClosing = useCallback(() => {
    if (!closing) return;
    const text = closingDraft.trim();
    if (text && !closing.nextTitle) {
      setGoals((gs) =>
        withSingleBookmark(gs, closing.goalId, { note: "", short: "" }).map((g) =>
          g.id === closing.goalId ? { ...g, process_steps: [...g.process_steps, makeStep(text)] } : g
        )
      );
    }
    setClosing(null);
    setClosingDraft("");
    setActiveGoalId(null);
    setTone(null);
    setExcludeIds([]);
    setCandidateIndex(0);
    setScreen("tone");
  }, [closing, closingDraft]);

  /* 目標の完了。未消化の工程はそのまま残して記録として見せる。 */
  const completeGoal = useCallback((goalId) => {
    const goal = goalsRef.current.find((g) => g.id === goalId);
    if (!goal) return;
    const now = Date.now();
    setGoals((gs) => gs.map((g) => (g.id === goalId ? { ...g, status: "完了", bookmark: null, completed_at: now, updated_at: now } : g)));
    setClosing(null);
    setClosingDraft("");
    setActiveGoalId(null);
    setSessionStart(null);
    setDetailGoalId(null);
    showVoice(`${goal.title}、完了！`, null, 1800, () => {
      setTone(null); setExcludeIds([]); setCandidateIndex(0);
      setScreen("tone");
    });
  }, [showVoice]);

  const handleRest = useCallback(() => {
    setTone(null); setExcludeIds([]); setSplitting(false);
    setScreen(bookmarkedGoal ? "opening-bookmark" : "opening-no-bookmark");
  }, [bookmarkedGoal]);

  const openShelf = useCallback(() => { setShelfReturn(screen); setScreen("shelf"); }, [screen]);
  const closeShelf = useCallback(() => setScreen(shelfReturn), [shelfReturn]);

  const openGoalDetail = useCallback((gid) => { setDetailGoalId(gid); setScreen("goal-detail"); }, []);
  const closeGoalDetail = useCallback(() => { setDetailGoalId(null); setScreen("shelf"); }, []);

  /* 詳細画面の操作 */
  const detailGoal = detailGoalId ? goalById[detailGoalId] : null;

  const patchDetail = useCallback((fn) => {
    setGoals((gs) => gs.map((g) => (g.id === detailGoalId ? fn(g) : g)));
  }, [detailGoalId]);

  // 次の一手の確定＝工程の先頭を置き換える（新規追加ではない）
  const setHeadStep = useCallback((text) => {
    const t = text.trim();
    if (!t) return;
    patchDetail((g) => {
      const head = nextStepOf(g);
      if (head) {
        return { ...g, process_steps: g.process_steps.map((s) => (s.id === head.id ? { ...s, title: t } : s)) };
      }
      return { ...g, process_steps: [...g.process_steps, makeStep(t)] };
    });
  }, [patchDetail]);

  const addStep = useCallback((title) => {
    const t = title.trim();
    if (!t) return;
    patchDetail((g) => ({ ...g, process_steps: [...g.process_steps, makeStep(t)] }));
  }, [patchDetail]);

  // 割り込み：追加した一手がそのまま次の一手になる
  const addStepAtHead = useCallback((title) => {
    const t = title.trim();
    if (!t) return;
    patchDetail((g) => {
      const idx = g.process_steps.findIndex((s) => !s.done);
      const at = idx < 0 ? g.process_steps.length : idx;
      const arr = [...g.process_steps];
      arr.splice(at, 0, makeStep(t));
      return { ...g, process_steps: arr };
    });
  }, [patchDetail]);

  const deleteStep = useCallback((sid) => {
    patchDetail((g) => ({ ...g, process_steps: g.process_steps.filter((s) => s.id !== sid) }));
  }, [patchDetail]);

  const moveStep = useCallback((sid, dir) => {
    patchDetail((g) => {
      const arr = [...g.process_steps];
      const i = arr.findIndex((s) => s.id === sid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return g;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...g, process_steps: arr };
    });
  }, [patchDetail]);

  const setGoalCapacity = useCallback((cap) => {
    patchDetail((g) => ({ ...g, capacity: cap, updated_at: Date.now() }));
  }, [patchDetail]);

  // 育った工程を独立した目標に昇格させる（一階層を保つための逃し弁）
  const promoteStep = useCallback((sid) => {
    const goal = goalsRef.current.find((g) => g.id === detailGoalId);
    if (!goal) return;
    const step = (goal.process_steps || []).find((s) => s.id === sid);
    if (!step) return;
    const now = Date.now();
    setGoals((gs) => [
      ...gs.map((g) => (g.id === detailGoalId ? { ...g, process_steps: g.process_steps.filter((s) => s.id !== sid) } : g)),
      {
        id: newId(), title: step.title, category: goal.category,
        capacity: goal.capacity || DEFAULT_CAPACITY,
        important_flag: false, status: "未着手",
        process_steps: [makeStep(step.title)],
        steps_done: [], felt_progress: null, bookmark: null,
        passed_count: 0, last_passed_at: null,
        last_touched_at: now, created_at: now,
      },
    ]);
  }, [detailGoalId]);

  const setFelt = useCallback((v) => {
    const n = v === "" ? null : Math.max(0, Math.min(100, parseInt(v, 10) || 0));
    patchDetail((g) => ({ ...g, felt_progress: n }));
  }, [patchDetail]);

  const toggleImportant = useCallback(() => {
    patchDetail((g) => ({ ...g, important_flag: !g.important_flag }));
  }, [patchDetail]);

  const setCategoryOf = useCallback((c) => {
    patchDetail((g) => ({ ...g, category: c }));
  }, [patchDetail]);

  const toggleSleep = useCallback(() => {
    const goal = goalsRef.current.find((g) => g.id === detailGoalId);
    if (!goal) return;
    const sleeping = goal.status === "寝かせ";
    patchDetail((g) => ({ ...g, status: sleeping ? "進行中" : "寝かせ", bookmark: sleeping ? g.bookmark : null, updated_at: Date.now() }));
    if (!sleeping) showVoice("手放した。", null, 1100, () => { setDetailGoalId(null); setScreen("shelf"); });
  }, [detailGoalId, patchDetail, showVoice]);

  const wakeGoal = useCallback((gid) => {
    setGoals((gs) => gs.map((g) => (g.id === gid ? { ...g, status: "進行中", last_touched_at: Date.now(), updated_at: Date.now() } : g)));
  }, []);

  const deleteDoneGoal = useCallback((gid) => {
    setGoals((gs) => gs.filter((g) => g.id !== gid));
  }, []);

  /* 仕分け（入口は「いま抱えているもの」から） */
  const startSorting = useCallback(() => { setScreen("sorting"); }, []);

  const sortingMakeGoal = useCallback((item, title, action, category, capacity) => {
    if (!item || !title.trim()) return;
    const now = Date.now();
    setGoals((gs) => [
      ...gs,
      {
        id: newId(), title: title.trim(), category: category || "仕事",
        capacity: capacity || DEFAULT_CAPACITY,
        important_flag: false, status: "未着手",
        process_steps: action.trim() ? [makeStep(action.trim())] : [],
        steps_done: [], felt_progress: null, bookmark: null,
        passed_count: 0, last_passed_at: null,
        last_touched_at: now, created_at: now,
      },
    ]);
    setCaptures((cs) => cs.filter((c) => c.id !== item.id));
  }, []);

  const sortingDrop = useCallback((item) => {
    if (!item) return;
    setCaptures((cs) => cs.filter((c) => c.id !== item.id));
    showVoice("手放した。", null, 1100, null);
  }, [showVoice]);

  /* 投げ込み */
  const openCapture = useCallback(() => { setCaptureOpen(true); setCaptureText(""); }, []);
  const cancelCapture = useCallback(() => {
    setCaptureOpen(false); setCaptureText("");
    if (listening && recognitionRef.current) { recognitionRef.current.stop(); setListening(false); }
  }, [listening]);
  const submitCapture = useCallback(() => {
    const t = captureText.trim();
    if (!t) return;
    setCaptures((cs) => [...cs, { id: newId(), text: t, created_at: Date.now(), source: "pwa", status: "unsorted" }]);
    setCaptureOpen(false); setCaptureText("");
    if (listening && recognitionRef.current) { recognitionRef.current.stop(); setListening(false); }
    showVoice("受け取った。記録した。", null, 1400, null);
  }, [captureText, listening, showVoice]);

  /* デモ操作（DEV_TOOLS が false なら出ない）
     栞ありSEEDへの一括置き換え（devReset）は Phase 0.5 で廃止した。
     実データが入っている状態で SEED_GOALS に置き換えると、同期エフェクトが
     「元あった実データは全部消えた」と解釈して本当に削除してしまうため。
     フレーム外のテスト操作が本番データを壊せてはいけない。 */
  const devNoBookmark = useCallback(() => {
    setGoals((gs) => gs.map((g) => ({ ...g, bookmark: null })));
    setActiveGoalId(null); setTone(null); setExcludeIds([]); setSplitting(false);
    setSessionStart(null); setCaptureOpen(false); setScreen("opening-no-bookmark");
  }, []);
  const devAdvance = useCallback(() => setDevOffsetMs((v) => v + 10 * 60000), []);

  const bmStep = bookmarkedGoal ? nextStepOf(bookmarkedGoal) : null;
  const closingGoal = closing ? goalById[closing.goalId] : null;

  return (
    <div className="horme-stage">
      <style>{CSS}</style>

      <div className="horme-frame">
        <div className="horme-statusbar">
          <span className="clock">{clock}</span>
          <span className="wordmark">HORME</span>
        </div>

        <div className={`horme-screen ${captureOpen ? "dimmed" : ""}`}>
          {screen === "loading" && <LoadingScreen />}
          {screen === "auth" && (
            <AuthGate
              mode={authScreen}
              email={authEmail}
              setEmail={setAuthEmail}
              code={authCode}
              setCode={setAuthCode}
              busy={authBusy}
              error={authError}
              onSend={handleSendCode}
              onVerify={handleVerifyCode}
              onResend={handleResendCode}
              onBack={handleBackToEmail}
            />
          )}
          {screen === "welcome" && <WelcomeScreen busy={welcomeBusy} onSeed={seedAccount} onSkip={skipSeed} />}

          {screen === "opening-bookmark" && bookmarkedGoal && bmStep && (
            <OpeningBookmark
              goal={bookmarkedGoal}
              step={bmStep}
              showHint={!seenHint}
              graceActive={graceActive}
              onContinue={handleContinue}
              onDifferent={handleDifferent}
            />
          )}
          {screen === "opening-bookmark" && !(bookmarkedGoal && bmStep) && (
            <OpeningNoBookmark onSelectTone={handleSelectTone} onShelf={openShelf} onRest={handleRest} />
          )}
          {screen === "opening-no-bookmark" && (
            <OpeningNoBookmark onSelectTone={handleSelectTone} onShelf={openShelf} onRest={handleRest} />
          )}
          {screen === "focus" && activeGoal && activeStep && (
            <Focus
              goal={activeGoal}
              step={activeStep}
              elapsedMinutes={elapsedMinutes}
              onFinish={handleFinish}
              onAddNote={handleAddNote}
              onEndGoal={() => completeGoal(activeGoal.id)}
            />
          )}
          {screen === "tone" && (
            <ToneCandidates
              tone={tone}
              candidates={candidates}
              index={candidateIndex}
              onSelectTone={handleSelectTone}
              onReject={handleReject}
              onSelect={handleSelectCandidate}
              onNone={handleNone}
              onShelf={openShelf}
              onRest={handleRest}
              splitting={splitting}
              splitDraft={splitDraft}
              setSplitDraft={setSplitDraft}
              onSplitStart={handleSplitStart}
              onSplitSubmit={handleSplitSubmit}
              onSplitCancel={handleSplitCancel}
              onLetGo={handleLetGo}
              onKeepAsIs={handleKeepAsIs}
            />
          )}
          {screen === "shelf" && (
            <Shelf
              goals={goals}
              unsortedCount={unsorted.length}
              onClose={closeShelf}
              onOpenGoal={openGoalDetail}
              onStartSorting={startSorting}
              onWake={wakeGoal}
              onDeleteDone={deleteDoneGoal}
            />
          )}
          {screen === "goal-detail" && detailGoal && (
            <GoalDetail
              goal={detailGoal}
              onClose={closeGoalDetail}
              onSetHeadStep={setHeadStep}
              onAddStep={addStep}
              onAddStepAtHead={addStepAtHead}
              onDeleteStep={deleteStep}
              onMoveStep={moveStep}
              onPromoteStep={promoteStep}
              onSetCapacity={setGoalCapacity}
              onSetFelt={setFelt}
              onToggleImportant={toggleImportant}
              onSetCategory={setCategoryOf}
              onSleep={toggleSleep}
              onComplete={() => completeGoal(detailGoal.id)}
            />
          )}
          {screen === "sorting" && (
            <Sorting
              items={unsorted}
              onMakeGoal={sortingMakeGoal}
              onDrop={sortingDrop}
              onClose={() => setScreen("shelf")}
            />
          )}

          {closing && closingGoal && (
            <ClosingPanel
              goal={closingGoal}
              minutes={closing.minutes}
              nextTitle={closing.nextTitle}
              draft={closingDraft}
              setDraft={setClosingDraft}
              onProceed={proceedFromClosing}
              onEndGoal={() => completeGoal(closing.goalId)}
            />
          )}

          {voice && <VoiceOverlay text={voice.text} sub={voice.sub} duration={voice.duration} />}
          {captureOpen && (
            <CaptureSheet
              text={captureText}
              setText={setCaptureText}
              onSubmit={submitCapture}
              onCancel={cancelCapture}
              listening={listening}
              speechSupported={speechSupported}
              onToggleListen={toggleListening}
            />
          )}
        </div>

        {!captureOpen && !["loading", "auth", "welcome"].includes(screen) && (
          <BottomCaptureHandle onOpen={openCapture} />
        )}
      </div>

      {DEV_TOOLS && (
        <div className="dev-panel">
          <p className="dev-label">参考 — デモ操作（フレーム外・実UIではない）</p>
          <div className="dev-actions">
            <button className="dev-btn" onClick={devNoBookmark}>栞なしから始める</button>
            <button className="dev-btn" onClick={devAdvance}>経過を+10分</button>
            <button className={`dev-btn ${ignoreCooldown ? "on" : ""}`} onClick={() => setIgnoreCooldown((v) => !v)}>
              クールダウン無視 {ignoreCooldown ? "on" : "off"}
            </button>
            <button className={`dev-btn ${diagOpen ? "on" : ""}`} onClick={() => setDiagOpen((v) => !v)}>
              調子の効きを見る
            </button>
          </div>

          {diagOpen && (() => {
            const d = diagnoseTones(goals);
            return (
              <div className="diag">
                <h4>いまの状態で、調子が候補に効いているか</h4>
                {d.slots.map((s) => (
                  <div className="diag-line" key={s.no}>
                    <span className="diag-key">{s.no}枠</span>
                    <span className={`diag-val ${s.stuck ? "diag-ng" : ""}`}>
                      {s.stuck ? "★全調子で同一 — " : ""}
                      {s.names.map((n) => n || "—").join(" / ")}
                    </span>
                  </div>
                ))}
                <div className="diag-line">
                  <span className="diag-key">共通</span>
                  <span className={`diag-val ${d.common.length > 1 ? "diag-ng" : ""}`}>
                    {d.common.length ? d.common.join(", ") : "なし"}
                  </span>
                </div>
                <div className="diag-line">
                  <span className="diag-key">容量</span>
                  <span className={`diag-val ${d.violations.length ? "diag-ng" : "diag-ok"}`}>
                    {d.violations.length ? d.violations.join(" / ") : "足切りを守っている"}
                  </span>
                </div>
                <div className="diag-line">
                  <span className="diag-key">判定</span>
                  <span className={`diag-val ${d.varying >= 3 ? "diag-ok" : d.varying >= 2 ? "" : "diag-ng"}`}>
                    3枠中 {d.varying}枠が調子で変わる
                    {d.varying >= 3 ? "（正常）" : d.varying >= 2 ? "（抱えが少ないと起こりうる）" : "（調子が効いていない）"}
                  </span>
                </div>
                <p className="diag-note">
                  順に 快調 / 平常 / 低調。本命枠が出る回で測っている。
                  中断中のものは容量の合う調子でだけ先頭に固定されるので、枠が全調子で同一になったら★が付く。
                </p>
              </div>
            );
          })()}
        </div>
      )}

      {session && (
        <div className="dev-logout-row">
          <button className="dev-logout-btn" onClick={handleLogout}>ログアウト（{session.email}）</button>
        </div>
      )}

      {syncError && <p className="sync-note">保存できていない可能性がある：{syncError}</p>}
    </div>
  );
}
