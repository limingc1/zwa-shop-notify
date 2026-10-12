/**
 * 掌瓦每日商店 → 微信推送（Cloudflare Worker + Cron + D1）
 *
 * 凭据模型（规划 2.2 / 7.4）：
 *  - D1 kv 表存加密后的 {mval, qq} 凭据，AES-256-GCM，密钥在 Secret CRED_KEY；
 *  - 商店查询失败且为登录过期 → 用 qq.access_token 静默重兑 tid → 成功则更新存储；
 *  - 重兑也失败 → 推送"手机扫码续期"链接（/reauth/page，全程免电脑）。
 * 触发：Cron 每日 UTC 00:05（北京 08:05）；或 GET /run?force=0 带 Bearer 手动触发。
 */

import { createDecipheriv } from "node:crypto";
import { handleReauth, startSession } from "./reauth";

export interface Env {
  DB: D1Database;
  SENDKEY: string;
  TRIGGER_TOKEN: string;
  CRED_KEY: string; // base64 32 字节 AES key
  WECOM_CORP_ID?: string;    // 企业微信：企业ID
  WECOM_CORP_SECRET?: string; // 企业微信：应用密钥
  WECOM_AGENT_ID?: string;   // 企业微信：应用 AgentId
  WECOM_RECEIVE_TOKEN?: string; // 企业微信：接收消息服务器校验 Token
  WECOM_AES_KEY?: string;       // 企业微信：EncodingAESKey（43位）
  WECOM_ROBOT_KEY?: string;     // 企业微信：群机器人 Webhook key（免可信IP，主通道）
}

// 本 Worker 的对外地址（续期链接用；从请求进来时优先用请求 origin）
const SELF_URL = "https://zwa.lim1ng.bond";

const API_BASE = "https://app.mval.qq.com";
const UA =
  "Mozilla/5.0 (Linux; Android 12; 23117RK66C Build/V417IR; wv) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Version/4.0 Chrome/101.0.4951.61 Mobile Safari/537.36";
const AUTH_ERROR_CODES = new Set([1001, 999999]);

/* ---------------- 加密 ---------------- */

async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(env.CRED_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptJson(obj: unknown, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(env),
    new TextEncoder().encode(JSON.stringify(obj)),
  );
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...buf));
}

async function decryptJson<T>(blob: string, env: Env): Promise<T> {
  const buf = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf.slice(0, 12) },
    await aesKey(env),
    buf.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ---------------- 存储读写 ---------------- */

interface Creds {
  userId: string; tid: string; openid: string; uin: number; access_token: string;
}
interface QQ { openid: string; access_token: string }
interface Bundle { mval: Creds; qq: QQ }

async function loadCreds(env: Env): Promise<Bundle | null> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key='creds'").first<{ value: string }>();
  if (!row) return null;
  return decryptJson<Bundle>(row.value, env);
}

async function saveCreds(bundle: Bundle, env: Env): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv (key,value) VALUES ('creds',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).bind(await encryptJson(bundle, env)).run();
}

async function loadWatch(env: Env): Promise<string[]> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key='watch'").first<{ value: string }>();
  return row ? (JSON.parse(row.value) as string[]) : [];
}

async function log(env: Env, event: string, ok: boolean, detail = ""): Promise<void> {
  await env.DB.prepare("INSERT INTO history (ts,event,ok,detail) VALUES (?,?,?,?)")
    .bind(Date.now() / 1000, event, ok ? 1 : 0, detail.slice(0, 400)).run();
}

/* ---------------- 掌瓦客户端 ---------------- */

class MvalError extends Error {
  code: number; authExpired: boolean;
  constructor(msg: string, code: number) {
    super(msg); this.code = code; this.authExpired = AUTH_ERROR_CODES.has(code);
  }
}

function cookieOf(c: Creds, variant: string): string {
  const token = c.access_token || "null";
  const parts = [
    "clientType=9", `uin=o${c.uin}`, "appid=102061775", "acctype=qc", `openid=${c.openid}`,
    variant === "real_token" ? `access_token=${token}`
      : variant === "scene" ? `access_token=${token}; scene=${token}`
      : "access_token=null",
    `userId=${c.userId}`, "accountType=5", `tid=${c.tid}`,
  ];
  return parts.join("; ");
}

async function mvalPost(path: string, creds: Creds, variant: string): Promise<unknown> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Cookie: cookieOf(creds, variant),
    },
    body: JSON.stringify({ _t: Math.floor(Date.now() / 1000) }),
  });
  let data: { result?: number; errMsg?: string; msg?: string; data?: unknown };
  try { data = await r.json() as typeof data; }
  catch { throw new MvalError("响应不是合法 JSON", -1); }
  const code = data.result ?? -1;
  if (code !== 0) throw new MvalError(data.errMsg || data.msg || `错误码 ${code}`, code);
  return data.data;
}

async function getStore(creds: Creds): Promise<unknown[]> {
  let last: MvalError | null = null;
  for (const v of ["real_token", "default", "scene"]) {
    try { return (await mvalPost("/go/mlol_store/agame/user_store", creds, v)) as unknown[]; }
    catch (e) {
      const err = e as MvalError;
      if (!(err instanceof MvalError)) throw e;
      last = err;
      if (!err.authExpired) throw err;
    }
  }
  throw last!;
}

/* ---------------- 静默重兑（阶段0已验证机制） ---------------- */

function deepFind(obj: unknown, keys: string[], depth = 4): unknown {
  if (depth <= 0 || obj == null || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const v of obj.slice(0, 5)) { const f = deepFind(v, keys, depth - 1); if (f) return f; }
    return null;
  }
  const rec = obj as Record<string, unknown>;
  for (const k of keys) if (rec[k] != null && rec[k] !== "" && rec[k] !== 0) return rec[k];
  for (const v of Object.values(rec)) { const f = deepFind(v, keys, depth - 1); if (f) return f; }
  return null;
}

async function renewWithQQ(qq: QQ): Promise<Creds> {
  const r = await fetch(`${API_BASE}/go/auth/login_by_qq?source_game_zone=agame&game_zone=agame`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Cookie: "clientType=9; openid=null; access_token=null;",
    },
    body: JSON.stringify({
      clienttype: 9,
      config_params: { client_dev_name: "23117RK66C", lang_type: 0 },
      login_info: {
        appid: 102061775, openid: qq.openid, qq_info_type: 5, sig: qq.access_token, uin: 0,
      },
      mappid: 10200, mcode: "132f0a77d34402abc8463d60100011d19b0e",
      source_game_zone: "agame", game_zone: "agame",
    }),
  });
  const data = await r.json() as { result?: number };
  if (data.result !== 0) throw new Error(`重兑失败 result=${data.result}`);
  const userId = deepFind(data, ["user_id", "userId", "userid", "uid_str"]);
  const tid = deepFind(data, ["wt", "tid", "ticket", "wticket"]);
  if (!userId || !tid) throw new Error("重兑响应缺少 userId/tid");
  return {
    userId: String(userId), tid: String(tid),
    openid: qq.openid, access_token: qq.access_token,
    uin: Number(deepFind(data, ["uin"]) || 0),
  };
}

/* ---------------- 格式化与推送 ---------------- */

const norm = (s: string) => (s || "").replace(/\s+/g, "").toLowerCase();

function formatShop(blocks: Record<string, unknown>[], watch: string[]) {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const md = `${String(bj.getUTCMonth() + 1).padStart(2, "0")}-${String(bj.getUTCDate()).padStart(2, "0")}`;
  let title = `掌瓦每日商店 · ${md}`;
  const lines: string[] = [];
  let hits = 0;
  const hitNames: string[] = [];

  for (const blk of blocks) {
    const items = (blk.list || []) as Record<string, unknown>[];
    if (blk.key === "kingdomstore") {
      lines.push(`〔${blk.title || "王国商店"}〕` +
        items.map((i) => i.goods_name).filter(Boolean).join("、"));
      continue;
    }
    const endTs = Number(blk.end_ts || 0);
    const endBj = new Date((endTs + 8 * 3600) * 1000);
    lines.push(`〔${blk.title || "每日商店"}〕本期至 ` +
      `${String(endBj.getUTCMonth() + 1).padStart(2, "0")}-${String(endBj.getUTCDate()).padStart(2, "0")} ` +
      `${String(endBj.getUTCHours()).padStart(2, "0")}:${String(endBj.getUTCMinutes()).padStart(2, "0")}`);
    for (const it of items) {
      const name = String(it.goods_name || "未知");
      const price = String(it.rmb_price || "");
      const like = String(it.like_num || "");
      const isHit = watch.some((w) => norm(w) === norm(name));
      if (isHit) { hits++; hitNames.push(name.replace(/\s+/g, "")); }
      lines.push(`${isHit ? "⭐ " : ""}${name}  ${price ? price + " VP" : ""}${like ? " · " + like : ""}`);
      const pic = String(it.goods_pic || "");
      if (pic.startsWith("http")) lines.push(`![${name}](${pic})`);
      lines.push("");
    }
  }
  if (hits > 0) {
    const shown = hitNames.slice(0, 2).join("、");
    title = `⭐${shown}${hitNames.length > 2 ? "等" : ""}出现在商店`;
  }
  return { title: title.slice(0, 30), body: lines.join("\n") };
}

async function pushSend(title: string, desp: string, env: Env): Promise<boolean> {
  // 主通道：企业微信群机器人（webhook 免可信IP；text 消息锁屏通知直接显示全文）
  if (env.WECOM_ROBOT_KEY) {
    const plain = desp
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")   // 机器人 text 不渲染图片
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\n{3,}/g, "\n\n");
    if (await robotSend(`【${title}】\n${plain}`.slice(0, 4000), env)) return true;
    await log(env, "robot_fallback", false, "机器人发送失败，降级");
  }
  // 备用通道：Server酱
  if (!env.SENDKEY) return false;
  const r = await fetch(`https://sctapi.ftqq.com/${env.SENDKEY}.send`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: title.slice(0, 64), desp }),
  });
  const data = await r.json() as { code?: number };
  return data.code === 0;
}

/** 企业微信群机器人 Webhook 发送（无需 access_token / 可信IP） */
async function robotSend(content: string, env: Env): Promise<boolean> {
  const r = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(env.WECOM_ROBOT_KEY || "")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content } }),
    },
  );
  const d = await r.json() as { errcode?: number; errmsg?: string };
  if (d.errcode !== 0) await log(env, "robot_send", false, `${d.errcode} ${d.errmsg || ""}`);
  return d.errcode === 0;
}

interface Article { title: string; description: string; url: string; picurl?: string }

/** 图文卡片消息：每件商品一张带图卡片（聊天内直接显示图片） */
async function robotSendNews(articles: Article[], env: Env): Promise<boolean> {
  const r = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(env.WECOM_ROBOT_KEY || "")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "news", news: { articles: articles.slice(0, 8) } }),
    },
  );
  const d = await r.json() as { errcode?: number; errmsg?: string };
  if (d.errcode !== 0) await log(env, "robot_news", false, `${d.errcode} ${d.errmsg || ""}`);
  return d.errcode === 0;
}

function buildArticles(blocks: Record<string, unknown>[], watch: string[], url: string): Article[] {
  const arts: Article[] = [];
  for (const blk of blocks) {
    const sec = String(blk.title || blk.key || "");
    for (const it of (blk.list || []) as Record<string, unknown>[]) {
      const name = String(it.goods_name || "未知");
      const isHit = watch.some((w) => norm(w) === norm(name));
      const price = String(it.rmb_price || "");
      const like = String(it.like_num || "");
      const desc = [sec, price ? `${price} VP` : "", like].filter(Boolean).join(" · ");
      const pic = String(it.goods_pic || "");
      arts.push({
        title: (isHit ? "⭐ " : "") + name,
        description: desc,
        url,
        picurl: pic.startsWith("http") ? pic : undefined,
      });
    }
  }
  return arts;
}

/** 网页版商店的分享链接：随机 token（可放进推送，泄露面最小） */
async function shopUrl(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key='shop_token'").first<{ value: string }>();
  let token = row?.value || "";
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare(
      "INSERT INTO kv (key,value) VALUES ('shop_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(token).run();
  }
  return `${SELF_URL}/shop?t=${token}`;
}

/** 企业微信 access_token（有效期 7200s，缓存进 D1 并提前 300s 续期） */
async function wecomToken(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key='wecom_token'").first<{ value: string }>();
  if (row) {
    try {
      const c = JSON.parse(row.value) as { token: string; exp: number };
      if (c.exp > Date.now() / 1000 + 60) return c.token;
    } catch { /* 缓存损坏则重新获取 */ }
  }
  const r = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${env.WECOM_CORP_ID}&corpsecret=${env.WECOM_CORP_SECRET}`,
  );
  const d = await r.json() as { errcode?: number; access_token?: string; expires_in?: number; errmsg?: string };
  if (d.errcode !== 0 || !d.access_token) {
    await log(env, "wecom_token", false, `${d.errcode} ${d.errmsg || ""}`);
    return null;
  }
  const exp = Date.now() / 1000 + (d.expires_in || 7200) - 300;
  await env.DB.prepare(
    "INSERT INTO kv (key,value) VALUES ('wecom_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).bind(JSON.stringify({ token: d.access_token, exp })).run();
  return d.access_token;
}

async function wecomSend(title: string, text: string, env: Env): Promise<boolean> {
  const token = await wecomToken(env);
  if (!token) return false;
  const content = `【${title}】\n${text}`.slice(0, 2000);
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      touser: "@all",
      msgtype: "text",
      agentid: Number(env.WECOM_AGENT_ID || 0),
      text: { content },
    }),
  });
  const d = await r.json() as { errcode?: number; errmsg?: string };
  if (d.errcode !== 0) await log(env, "wecom_send", false, `${d.errcode} ${d.errmsg || ""}`);
  return d.errcode === 0;
}

/* ---------------- 主流程 ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 查商店（带当场退避重试 + 过期静默续期）。
 * 掌瓦 8 点整刷新时全国并发，201「人数过多」是瞬时拥堵，等 10s/30s 再试大概率能过。
 * 返回 blocks；失败时抛出 {authFailed, msg} 标记的对象。
 */
async function fetchStoreWithRetry(env: Env, bundle: Bundle): Promise<unknown[]> {
  let blocks: unknown[] | null = null;
  let lastMsg = "";
  for (let i = 0; i < 3; i++) {
    try {
      try {
        blocks = await getStore(bundle.mval);
      } catch (e) {
        if (!(e instanceof MvalError) || !e.authExpired) throw e;
        // 登录过期 → 用 QQ token 静默重兑一次（重兑失败=必须人工扫码）
        let fresh: Creds;
        try {
          fresh = await renewWithQQ(bundle.qq);
        } catch (e2) {
          throw { authFailed: true, msg: String(e2) };
        }
        blocks = await getStore(fresh); // 这里若是瞬时错误会走外层重试
        bundle.mval = fresh;
        await saveCreds(bundle, env);
        await log(env, "auto_renew", true, "");
      }
      return blocks!;
    } catch (e) {
      if (e && typeof e === "object" && "authFailed" in e) throw e;
      const err = e as MvalError;
      lastMsg = err instanceof MvalError ? `code=${err.code} ${err.message}` : String(err);
      await log(env, "store_retry", false, `第${i + 1}次失败：${lastMsg}`);
      if (i < 2) await sleep((i === 0 ? 10 : 30) * 1000);
    }
  }
  throw { authFailed: false, msg: lastMsg || "未知错误" };
}

async function runCycle(env: Env, force = false, notify = true, alertOnFail = true): Promise<string> {
  const bundle = await loadCreds(env);
  if (!bundle) { await log(env, "run", false, "no creds"); return "无凭据：先运行 import-creds"; }

  let blocks: unknown[] | null = null;
  try {
    blocks = await fetchStoreWithRetry(env, bundle);
  } catch (e) {
    const { authFailed, msg } = e as { authFailed: boolean; msg: string };
    if (authFailed) {
      // 需人工扫码：当天只提醒一次（多补偿窗口防重复），且立即提醒不等最后窗口
      const dayKey = "reauth_alerted_" + new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      const already = await env.DB.prepare("SELECT 1 FROM kv WHERE key=?").bind(dayKey).first();
      if (notify && !already) {
        await env.DB.prepare("INSERT OR IGNORE INTO kv (key,value) VALUES (?,?)").bind(dayKey, "1").run();
        const link = await makeReauthLink(env);
        await pushSend("掌瓦商店通知·需重新授权",
          `登录态过期且静默续期失败。\n\n` +
          `📱 **复制下面链接，用手机浏览器打开**（微信内置浏览器会拦截，别在微信里点）：\n\n` +
          `\`${link}\`\n\n` +
          `页面出二维码后：截屏 → QQ 扫一扫 → 相册选截图 → 确认。\n` +
          `续期成功后会自动补推今天的商店。链接 30 分钟内有效。`, env);
      }
      return "已过期且重兑失败，待扫码" + (notify && !already ? "，已发续期链接" : "");
    }
    // 瞬时/接口故障：只在当天最后一个补偿窗口报丧，避免三连发
    await log(env, "run", false, `store: ${msg}`);
    if (notify && alertOnFail)
      await pushSend("掌瓦商店通知·故障", `商店查询多次失败（今日 08:20/09:30/12:00 三个窗口均失败）：${msg}`, env);
    return `商店查询失败：${msg}`;
  }

  const typed = (blocks || []) as Record<string, unknown>[];

  // 网页版商店页快照：每次成功抓取都更新（放在去重判断之前，保证页面数据最新）
  await env.DB.prepare(
    "INSERT INTO kv (key,value) VALUES ('shop_latest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).bind(JSON.stringify({ fetched_at: Date.now() / 1000, blocks: typed })).run();

  let endTs = 0;
  for (const b of typed) { if (b.key === "dailystore" && b.end_ts) { endTs = Number(b.end_ts); break; } }
  if (!force && endTs) {
    const dup = await env.DB.prepare("SELECT 1 FROM notified WHERE end_ts=?").bind(endTs).first();
    if (dup) return "本期已通知，跳过";
  }
  if (!notify) return `商店可用（end_ts=${endTs}），未推送`;

  const watch = await loadWatch(env);
  const { title, body } = formatShop(typed, watch);
  const shopLink = await shopUrl(env);
  const articles = buildArticles(typed, watch, shopLink);
  const ok = await pushShop(title, body, articles, env);
  await log(env, "run", ok, `end_ts=${endTs}`);
  if (ok && endTs) {
    await env.DB.prepare("INSERT OR IGNORE INTO notified (end_ts,sent_at) VALUES (?,?)")
      .bind(endTs, Date.now() / 1000).run();
  }
  return ok ? "推送成功" : "推送失败（所有通道均未受理）";
}

/** 商店推送优先级：机器人图文卡片 → 机器人文本 → Server酱 */
async function pushShop(title: string, body: string, articles: Article[], env: Env): Promise<boolean> {
  if (env.WECOM_ROBOT_KEY && articles.length) {
    if (await robotSendNews(articles, env)) return true;
    await log(env, "news_fallback", false, "图文失败，降级文本");
  }
  return pushSend(title, body, env);
}

/* ---------------- 企业微信：接收消息服务器 URL 归属验证 ---------------- */

async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 从原始 query 提取参数：只做 %XX 解码、不做 +→空格 替换。
 *  企微 echostr 是 base64（可能含 +），若按表单规则把 + 解成空格，签名必然失败。 */
function rawParam(search: string, name: string): string {
  for (const part of search.replace(/^\?/, "").split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    let k = part.slice(0, i), v = part.slice(i + 1);
    try { k = decodeURIComponent(k); v = decodeURIComponent(v); } catch { /* 保留原值 */ }
    if (k === name) return v;
  }
  return "";
}

async function wecomVerify(url: URL, env: Env): Promise<Response> {
  try {
    const sig = rawParam(url.search, "msg_signature");
    const ts = rawParam(url.search, "timestamp");
    const nonce = rawParam(url.search, "nonce");
    const echo = rawParam(url.search, "echostr");
    console.log(`cb 参数: sig=${sig} ts=${ts} nonce=${nonce} echoLen=${echo.length}`);
    if (!sig || !echo) return new Response("参数不全", { status: 400 });
    if (!env.WECOM_RECEIVE_TOKEN || !env.WECOM_AES_KEY) return new Response("未配置 Token/AESKey", { status: 500 });

    // 1) 签名校验：[token, timestamp, nonce, echostr] 字典序拼接 SHA1
    const joined = [env.WECOM_RECEIVE_TOKEN, ts, nonce, echo].sort().join("");
    const mine = await sha1Hex(joined);
    console.log(`签名: 本地=${mine} 收到=${sig} 匹配=${mine === sig}`);
    if (mine !== sig) return new Response("签名校验失败", { status: 403 });

    // 2) AES-256-CBC 解密 echostr（密钥=AESKey base64 解码，IV=前16字节）
    //    用 node:crypto 关闭自动填充：企微按 32 字节块填充（值可到 32），
    //    WebCrypto 的 PKCS7 只认 16，手动关填充后按长度字段取正文最稳。
    const keyBytes = Uint8Array.from(atob(env.WECOM_AES_KEY + "="), (c) => c.charCodeAt(0));
    const iv = keyBytes.slice(0, 16);
    const cipher = Uint8Array.from(atob(echo), (c) => c.charCodeAt(0));
    const decipher = createDecipheriv("aes-256-cbc", keyBytes, iv);
    decipher.setAutoPadding(false);
    const plain = new Uint8Array(Buffer.concat([
      Buffer.from(decipher.update(Buffer.from(cipher))),
      Buffer.from(decipher.final()),
    ]));
    // 明文结构：random(16) + msg_len(4, 大端) + msg + receiveid + 填充
    const msgLen = (plain[16] << 24) | (plain[17] << 16) | (plain[18] << 8) | plain[19];
    const msg = new TextDecoder().decode(plain.slice(20, 20 + msgLen));
    console.log(`解密成功, echo 回显长度=${msg.length}`);
    return new Response(msg, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (e) {
    console.log(`回调异常: ${e}`);
    return new Response(`内部错误: ${e}`, { status: 500 });
  }
}

/** 网页版商店页（手机浏览器收藏，一屏看全带图；点 ⭐ 管理关注） */
function shopHtml(snap: { fetched_at: number; blocks: Record<string, unknown>[] }, watch: string[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const bj = (ts: number) => {
    const d = new Date((ts + 8 * 3600) * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };
  const qualityColor: Record<string, string> = {
    orange: "#e0700f", blue: "#3a7bd5", red: "#c0392b", green: "#27ae60",
    purple: "#8e44ad", yellow: "#d4ac0d", pink: "#e84393", grey: "#7f8c8d",
  };
  const norm = (s: string) => (s || "").replace(/\s+/g, "").toLowerCase();
  const watchSet = new Set(watch.map(norm));
  // 商店里出现过的名字（用于找出"手动添加但今天没刷出"的关注项）
  const shopNames = new Set<string>();
  for (const blk of snap.blocks)
    for (const it of (blk.list || []) as Record<string, unknown>[])
      shopNames.add(norm(String(it.goods_name || "")));
  const manualNames = watch.filter((w) => !shopNames.has(norm(w)));

  let html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>掌瓦每日商店</title><style>
body{font-family:system-ui,sans-serif;background:#111418;color:#e8e8e8;margin:0;padding:16px}
h2{font-size:17px;margin:18px 0 4px;color:#fff}
.meta{font-size:12px;color:#8a919a;margin-bottom:10px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.card{position:relative;background:#1c2128;border-radius:12px;overflow:hidden;border:1px solid #2a313a}
.card img{width:100%;aspect-ratio:16/10;object-fit:contain;background:#0d1117;display:block}
.info{padding:8px 10px}
.name{font-size:14px;font-weight:600}
.price{font-size:13px;color:#ffb86c;margin-top:2px}
.like{font-size:11px;color:#8a919a}
.watched{border-color:#ffb86c;box-shadow:0 0 0 1px #ffb86c}
.star{position:absolute;top:6px;right:6px;width:40px;height:40px;border:0;border-radius:10px;
background:rgba(13,17,23,.72);color:#8a919a;font-size:22px;line-height:1;cursor:pointer;z-index:2}
.star.on{color:#ffb86c}
#tip{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#2a313a;color:#fff;
padding:8px 16px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:9}
#tip.show{opacity:1}
</style></head><body>
<h2 style="margin-top:4px">掌瓦每日商店</h2>
<div class="meta">数据抓取于 ${esc(bj(snap.fetched_at))}（北京时间）· 商店每天 08:00 刷新 · 点卡片右上角 ⭐ 关注该皮肤</div>`;

  for (const blk of snap.blocks) {
    const items = (blk.list || []) as Record<string, unknown>[];
    const endTs = Number(blk.end_ts || 0);
    html += `<h2>${esc(String(blk.title || blk.key || ""))}</h2>`;
    if (endTs) html += `<div class="meta">本期至 ${esc(bj(endTs))}</div>`;
    html += `<div class="grid">`;
    for (const it of items) {
      const name = String(it.goods_name || "未知");
      const q = String(it.quality || "").toLowerCase();
      const color = qualityColor[q] || "#8a919a";
      const price = String(it.rmb_price || "");
      const like = String(it.like_num || "");
      const pic = String(it.goods_pic || "");
      const on = watchSet.has(norm(name));
      html += `<div class="card${on ? " watched" : ""}" data-name="${esc(name)}">`;
      html += `<button class="star${on ? " on" : ""}" aria-label="关注">${on ? "★" : "☆"}</button>`;
      if (pic.startsWith("http")) html += `<img src="${esc(pic)}" alt="${esc(name)}" loading="lazy">`;
      html += `<div class="info"><div class="name" style="color:${color}">${esc(name)}</div>`;
      if (price) html += `<div class="price">${esc(price)} VP</div>`;
      if (like) html += `<div class="like">${esc(like)}</div>`;
      html += `</div></div>`;
    }
    html += `</div>`;
  }

  html += `<div class="panel" style="margin-top:18px;background:#1c2128;border:1px solid #2a313a;border-radius:12px;padding:12px">
<div class="meta" style="margin:0 0 8px">提前关注（皮肤还没刷出来时按名字添加，需与游戏内名称一致）</div>
<div style="display:flex;gap:8px">
<input id="addName" placeholder="如：混沌序幕 狂徒" style="flex:1;background:#0d1117;border:1px solid #2a313a;border-radius:8px;color:#e8e8e8;padding:9px 12px;font-size:14px">
<button id="addBtn" style="border:0;border-radius:8px;background:#2563eb;color:#fff;padding:0 18px;font-size:14px">添加</button>
</div>
<div id="manualList" class="meta" style="margin:8px 0 0"></div>
</div>
<div id="tip"></div>
<div class="meta" style="margin-top:24px">关注的皮肤出现在商店时，推送标题会带 ⭐ 皮肤名</div>
<script>
const shopToken=new URLSearchParams(location.search).get('t')||new URLSearchParams(location.search).get('key')||'';
const norm=s=>(s||'').replace(/\\s+/g,'').toLowerCase();
const manual=${JSON.stringify(manualNames)}; // 手动添加、当前商店里没有卡片的关注名
function tip(t){const e=document.getElementById('tip');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),1800);}
function esc2(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;');}
function renderManual(){
  const box=document.getElementById('manualList');
  if(!manual.length){box.textContent='';return;}
  box.innerHTML='已手动关注（点 × 移除）：'+manual.map((m,i)=>
    '<span class="mtag" data-i="'+i+'" style="display:inline-block;background:#2a313a;border-radius:12px;padding:2px 8px;margin:2px 4px 2px 0;cursor:pointer">'+esc2(m)+' ×</span>').join('');
  box.querySelectorAll('.mtag').forEach(t=>t.addEventListener('click',()=>{manual.splice(+t.dataset.i,1);renderManual();syncWatch();}));
}
async function syncWatch(){
  const names=[...document.querySelectorAll('.card.watched')].map(c=>c.dataset.name).concat(manual);
  try{
    const r=await fetch('/watch?t='+encodeURIComponent(shopToken),{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({names})});
    if(r.ok) tip(names.length? '关注列表已保存（'+names.length+' 件）' : '已清空关注');
    else tip('保存失败 '+r.status);
  }catch(e){tip('网络错误，未保存');}
}
document.querySelectorAll('.star').forEach(b=>b.addEventListener('click',ev=>{
  ev.stopPropagation();
  const card=b.closest('.card');
  const on=card.classList.toggle('watched');
  b.classList.toggle('on',on);
  b.textContent=on?'★':'☆';
  syncWatch();
}));
document.getElementById('addBtn').addEventListener('click',()=>{
  const inp=document.getElementById('addName');
  const v=inp.value.trim();
  if(!v)return;
  if(manual.some(m=>norm(m)===norm(v))||[...document.querySelectorAll('.card.watched')].some(c=>norm(c.dataset.name)===norm(v))){tip('已在关注列表');return;}
  manual.push(v);inp.value='';renderManual();syncWatch();
});
renderManual();
</script></body></html>`;
  return html;
}

/** 生成手机扫码续期链接（免电脑）。sid 为随机不可猜令牌。 */
async function makeReauthLink(env: Env, origin?: string): Promise<string> {
  const sid = await startSession(env);
  const base = (origin || SELF_URL).replace(/\/+$/, "");
  return `${base}/reauth/page?sid=${sid}`;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 三个窗口（UTC）：00:20 主（北京08:20）→ 01:30 → 04:00（北京12:00，最后才报丧）
    const hour = new Date(event.scheduledTime).getUTCHours();
    ctx.waitUntil(runCycle(env, false, true, hour === 4));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 企业微信域名归属验证文件（公开访问，验证服务器直接抓取，不走鉴权）
    if (url.pathname === "/WW_verify_PPQ7XbPNOjJuqTHS.txt") {
      return new Response("PPQ7XbPNOjJuqTHS", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // 企业微信「接收消息服务器URL」归属验证（GET 回调，公开访问）
    if (url.pathname === "/wecom/callback") {
      return await wecomVerify(url, env);
    }

    // 网页版商店页：手机浏览器收藏，一屏看全（带图）。
    // 钥匙二选一：TRIGGER_TOKEN（管理员）或 shop_token（可随推送分发的随机 token）
    if (url.pathname === "/shop") {
      const rowT = await env.DB.prepare("SELECT value FROM kv WHERE key='shop_token'").first<{ value: string }>();
      const given = url.searchParams.get("key") || url.searchParams.get("t") || "";
      if (!given || (given !== env.TRIGGER_TOKEN && given !== rowT?.value))
        return new Response("unauthorized", { status: 401 });
      const row = await env.DB.prepare("SELECT value FROM kv WHERE key='shop_latest'").first<{ value: string }>();
      if (!row) return new Response("还没有商店数据，等明早推送后刷新", { status: 503 });
      const snap = JSON.parse(row.value) as { fetched_at: number; blocks: Record<string, unknown>[] };
      return new Response(shopHtml(snap, await loadWatch(env)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 关注列表编辑（商店页的 ⭐ 按钮调用）：POST {names:[...]}
    if (url.pathname === "/watch" && request.method === "POST") {
      const rowT = await env.DB.prepare("SELECT value FROM kv WHERE key='shop_token'").first<{ value: string }>();
      const given = url.searchParams.get("t") || "";
      if (!given || (given !== env.TRIGGER_TOKEN && given !== rowT?.value))
        return new Response("unauthorized", { status: 401 });
      const body = await request.json() as { names?: unknown };
      if (!Array.isArray(body.names)) return new Response("bad", { status: 400 });
      const names = body.names
        .filter((x): x is string => typeof x === "string" && !!x.trim())
        .map((s) => s.trim()).slice(0, 50);
      await env.DB.prepare(
        "INSERT INTO kv (key,value) VALUES ('watch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).bind(JSON.stringify(names)).run();
      return Response.json({ ok: true, count: names.length });
    }

    // 手机续期路由：公开访问（随机 sid 即能力凭证，30 分钟有效），不走 Bearer
    if (url.pathname.startsWith("/reauth/")) {
      const resp = await handleReauth(url, env, () => {
        // 扫码续期成功 → 自动补推今天的商店
        ctx.waitUntil(runCycle(env));
      });
      return resp ?? new Response("not found", { status: 404 });
    }

    if (request.headers.get("Authorization") !== `Bearer ${env.TRIGGER_TOKEN}`)
      return new Response("unauthorized", { status: 401 });

    if (url.pathname === "/run") {
      const result = await runCycle(env, url.searchParams.get("force") === "1");
      return new Response(result + "\n");
    }

    // 手动索取一个手机续期链接（调试/主动换号用）
    if (url.pathname === "/reauth-link") {
      return new Response((await makeReauthLink(env, url.origin)) + "\n");
    }

    // 本地导入凭据：POST 明文 {mval, qq}，Worker 用自有 CRED_KEY 加密后落 D1。
    if (url.pathname === "/put-creds" && request.method === "POST") {
      const body = await request.json() as Bundle;
      if (!body?.mval?.tid || !body?.qq?.access_token)
        return new Response("凭据字段不完整", { status: 400 });
      await saveCreds(body, env);
      await log(env, "import_creds", true, "");
      return new Response("凭据已加密导入\n");
    }

    // 本地导入关注列表：POST 明文 ["皮肤名", ...]
    if (url.pathname === "/put-watch" && request.method === "POST") {
      const names = await request.json() as string[];
      if (!Array.isArray(names)) return new Response("需 JSON 数组", { status: 400 });
      await env.DB.prepare(
        "INSERT INTO kv (key,value) VALUES ('watch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).bind(JSON.stringify(names)).run();
      return new Response(`关注列表已导入（${names.length} 项）\n`);
    }

    // 状态查询：最近事件与本期是否已通知
    if (url.pathname === "/status") {
      const last = await env.DB.prepare("SELECT ts,event,ok,detail FROM history ORDER BY id DESC LIMIT 10").all();
      const cred = await env.DB.prepare("SELECT 1 FROM kv WHERE key='creds'").first();
      return Response.json({ has_creds: !!cred, history: last.results });
    }

    return new Response("not found", { status: 404 });
  },
};
