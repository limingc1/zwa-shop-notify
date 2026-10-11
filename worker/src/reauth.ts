/**
 * 手机端重新授权（免电脑扫码续期）。
 *
 * 流程：云端生成 QQ 扫码会话 → 手机打开 /reauth/page 看二维码 →
 *       页面轮询 /reauth/poll（Worker 代理轮询 QQ）→ 扫码确认后
 *       Worker 走完 check_sig → login_by_qq 兑换 → 新凭据加密落 D1。
 *
 * sid 为随机不可猜令牌，本身就是访问凭证（30 分钟有效）。
 * 逆向私有协议，无官方支持，可能随时失效。
 */

export interface ReauthEnv {
  DB: D1Database;
  CRED_KEY: string;
}

const LOGIN_URL =
  "https://xui.ptlogin2.qq.com/cgi-bin/xlogin?" +
  "pt_enable_pwd=1&appid=716027609&pt_3rd_aid=102061775&daid=381" +
  "&pt_skey_valid=0&style=35&force_qr=1&autorefresh=1" +
  "&s_url=http%3A%2F%2Fconnect.qq.com&refer_cgi=m_authorize" +
  "&ucheck=1&fall_to_wv=1&status_os=12" +
  "&redirect_uri=auth%3A%2F%2Ftauth.qq.com%2F" +
  "&client_id=102061775&pf=openmobile_android&response_type=token" +
  "&scope=all&sdkp=a&sdkv=3.5.17.lite" +
  "&sign=a6479455d3e49b597350f13f776a6288" +
  "&status_machine=MjMxMTdSSzY2Qw%3D%3D&switch=1" +
  "&time=1763280194&show_download_ui=true" +
  "&h5sig=trobryxo8IPM0GaSQH12mowKG-CY65brFzkK7_-9EW4" +
  "&loginty=6";

const PTQR_SHOW = "https://xui.ptlogin2.qq.com/ssl/ptqrshow";
const PTQR_LOGIN = "https://xui.ptlogin2.qq.com/ssl/ptqrlogin";
const AID = "716027609";
const DAID = "381";
const THIRD_AID = "102061775";
const U1 = "http://connect.qq.com";
const MVAL_LOGIN = "https://app.mval.qq.com/go/auth/login_by_qq?source_game_zone=agame&game_zone=agame";
const MCODE = "132f0a77d34402abc8463d60100011d19b0e";
const UA =
  "Mozilla/5.0 (Linux; Android 12; 23117RK66C Build/V417IR; wv) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Version/4.0 Chrome/101.0.4951.61 Mobile Safari/537.36";
const SESSION_TTL = 1800;

interface Sess {
  jar: Record<string, string>;
  png: string; // base64
  jsver: string;
  openlogin: string;
  aegis: string;
  login_sig: string;
  ptqrtoken: number;
  created: number; // 会话创建时刻（绝对上限判断用）
  touched: number; // 最近一次刷新二维码时刻（30 分钟空闲超时用）
  successUrl?: string;
  done?: boolean;
}

/* ---------- 工具 ---------- */

function calcPtqrtoken(qrsig: string): number {
  let t = 0n;
  for (const ch of qrsig) t += (t << 5n) + BigInt(ch.codePointAt(0) ?? 0);
  return Number(t & 2147483647n);
}

function extractJsver(html: string): string {
  for (const pat of [
    /\/monorepo\/([0-9A-Za-z]+)\/ptlogin\/js\/login_10\.js/,
    /\/monorepo\/([0-9A-Za-z]+)\/ptlogin\/js\//,
    /https:\/\/qq-web\.cdn-go\.cn\/monorepo\/([0-9A-Za-z]+)/,
  ]) {
    const m = pat.exec(html || "");
    if (m) return m[1];
  }
  return "28d22679";
}

function buildOpenlogin(loginUrl: string, idt: string): string {
  const q = new URL(loginUrl).searchParams;
  const gp = (n: string, d = "") => q.get(n) ?? d;
  const items: [string, string][] = [
    ["which", ""], ["refer_cgi", gp("refer_cgi", "m_authorize")],
    ["response_type", gp("response_type", "token")],
    ["client_id", gp("client_id", THIRD_AID)],
    ["state", ""], ["display", ""], ["openapi", "1011"],
    ["switch", gp("switch", "1")], ["src", "1"],
    ["sdkv", gp("sdkv", "3.5.17.lite")], ["sdkp", gp("sdkp", "a")],
    ["tid", idt], ["pf", gp("pf", "openmobile_android")],
    ["need_pay", "0"], ["browser", "0"], ["browser_error", ""],
    ["serial", ""], ["token_key", ""],
    ["redirect_uri", gp("redirect_uri", "auth://tauth.qq.com/")],
    ["sign", gp("sign", "")], ["time", gp("time", "")],
    ["status_version", ""], ["status_os", gp("status_os", "12")],
    ["status_machine", gp("status_machine", "")],
    ["page_type", "1"], ["has_auth", "1"], ["update_auth", "1"],
    ["auth_time", String(Date.now())],
    ["loginfrom", ""], ["h5sig", gp("h5sig", "")], ["loginty", gp("loginty", "6")],
  ];
  return new URLSearchParams(items).toString();
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorb(resp: Response, jar: Record<string, string>): void {
  let list: string[] = [];
  try { list = (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []; }
  catch { /* 环境不支持则跳过 */ }
  for (const line of list) {
    const pair = line.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

const normU = (u: string) => (u || "").replace(/\\\//g, "/").replace(/\\x26/gi, "&");

function parseQS(raw: string): Record<string, string> {
  const d: Record<string, string> = {};
  if (!raw) return d;
  for (const [k, v] of new URLSearchParams(raw.replace(/#&/g, "&").replace(/^&+/, ""))) d[k] = v;
  return d;
}

/** 从票据 URL/文本中提取全部参数（含嵌套跳转），移植自 valo-stat extract_login_data。 */
function extractLoginData(url: string): Record<string, string> {
  const merged: Record<string, string> = {};
  const visited = new Set<string>();
  const queue = [normU(url)];
  while (queue.length) {
    let candidate = queue.shift()!;
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    let decoded = candidate;
    for (let i = 0; i < 3; i++) {
      const nxt = decodeURIComponent(decoded);
      if (nxt === decoded) break;
      decoded = nxt;
    }
    const params: Record<string, string> = {};
    try {
      const pu = new URL(decoded.startsWith("auth://") ? decoded.replace("auth://", "https://") : decoded);
      Object.assign(params, parseQS(pu.search.slice(1)), parseQS(pu.hash));
    } catch {
      Object.assign(params, parseQS(decoded));
    }
    if (!Object.keys(params).length && (decoded.includes("openid=") || decoded.includes("access_token="))) {
      Object.assign(params, parseQS(decoded));
    }
    for (const [k, v] of Object.entries(params)) if (!(k in merged)) merged[k] = v;
    for (const nk of ["u1", "url", "redirect_uri", "s_url", "jump_url"]) {
      const nv = params[nk];
      if (nv && !visited.has(normU(nv))) queue.push(normU(nv));
    }
  }
  return merged;
}

function authUrlFromBody(body: string): string {
  const text = normU(body || "");
  const m = /_Callback\s*\(\s*(\{.*?\})\s*\)\s*;?\s*$/.exec(text);
  if (m) {
    try {
      const u = JSON.parse(m[1]).url as string;
      if (u?.startsWith("auth://")) return u;
    } catch { /* ignore */ }
  }
  return /auth:\/\/tauth\.qq\.com\/[^\s"'<>]+/.exec(text)?.[0] ?? "";
}

function urlFromBody(body: string): string {
  const text = normU(body || "");
  for (const pat of [
    /ptuiCB\('[^']*','[^']*','([^']+)'/,
    /location\.href\s*=\s*['"]([^'"]+)['"]/,
    /auth:\/\/tauth\.qq\.com\/[^\s"'<>]+/,
    /https?:\/\/[^\s"'<>]*check_sig[^\s"'<>]*/,
  ]) {
    const m = pat.exec(text);
    if (m) return (m[1] ?? m[0]).trim();
  }
  return "";
}

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

/* ---------- 加密与存储（与主 Worker 同方案） ---------- */

async function aesKey(env: ReauthEnv): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(env.CRED_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
}

async function encryptJson(obj: unknown, env: ReauthEnv): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env),
    new TextEncoder().encode(JSON.stringify(obj)));
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv, 0); buf.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...buf));
}

async function saveSession(env: ReauthEnv, sid: string, sess: Sess): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).bind("reauth:" + sid, JSON.stringify(sess)).run();
}

async function loadSession(env: ReauthEnv, sid: string): Promise<Sess | null> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key=?").bind("reauth:" + sid)
    .first<{ value: string }>();
  if (!row) return null;
  try { return JSON.parse(row.value) as Sess; } catch { return null; }
}

async function dropSession(env: ReauthEnv, sid: string): Promise<void> {
  await env.DB.prepare("DELETE FROM kv WHERE key=?").bind("reauth:" + sid).run();
}

async function saveCreds(env: ReauthEnv, bundle: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv (key,value) VALUES ('creds',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).bind(await encryptJson(bundle, env)).run();
}

/* ---------- QQ 扫码链路 ---------- */

const BASE_H = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Referer: "https://openmobile.qq.com/",
  "X-Requested-With": "com.tencent.apps.valorant",
};

async function fetchQr(jar: Record<string, string>): Promise<Sess> {
  const r = await fetch(LOGIN_URL, { headers: BASE_H, redirect: "manual" });
  const html = await r.text();
  absorb(r, jar);
  const idt = jar["idt"] || String(Math.floor(Date.now() / 1000));
  const sip = jar["pt_serverip"] || "", cip = jar["pt_clientip"] || "";
  const qrUrl = `${PTQR_SHOW}?s=8&e=0&appid=${AID}&type=0&t=${Math.random()}` +
    `&u1=${encodeURIComponent(U1)}&daid=${DAID}&pt_3rd_aid=${THIRD_AID}`;
  const qr = await fetch(qrUrl, {
    headers: { ...BASE_H, Referer: LOGIN_URL, Accept: "image/*" }, redirect: "manual",
  });
  absorb(qr, jar);
  const buf = new Uint8Array(await qr.arrayBuffer());
  const qrsig = jar["qrsig"];
  if (!qrsig) throw new Error("未拿到 qrsig");
  if (buf[0] !== 0x89) throw new Error("二维码非 PNG");
  return {
    jar,
    png: btoa(String.fromCharCode(...buf)),
    jsver: extractJsver(html),
    openlogin: buildOpenlogin(LOGIN_URL, idt),
    aegis: sip && cip ? `${sip}-${cip}-4458` : "",
    login_sig: jar["pt_login_sig"] || "",
    ptqrtoken: calcPtqrtoken(qrsig),
    created: Date.now() / 1000,
    touched: Date.now() / 1000,
  };
}

async function pollOnce(sess: Sess): Promise<[string, string, string]> {
  const p = new URLSearchParams({
    u1: U1, from_ui: "1", type: "1", ptlang: "2052",
    ptqrtoken: String(sess.ptqrtoken), daid: DAID, aid: AID, pt_3rd_aid: THIRD_AID,
    pt_openlogin_data: sess.openlogin,
    device: "2", ptopt: "1", pt_uistyle: "35", jsver: sess.jsver, r: String(Math.random()),
  });
  if (sess.login_sig) p.set("login_sig", sess.login_sig);
  if (sess.aegis) p.set("aegis_uid", sess.aegis);
  const r = await fetch(`${PTQR_LOGIN}?${p}`, {
    headers: {
      "User-Agent": UA + " tencent_game_emulator",
      Referer: LOGIN_URL, Accept: "*/*",
      "X-Requested-With": "com.tencent.apps.valorant",
      Cookie: cookieHeader(sess.jar),
    },
    redirect: "manual",
  });
  absorb(r, sess.jar);
  const text = await r.text();
  const m = /ptuiCB\('([^']*)','([^']*)','([^']*)','([^']*)','([^']*)'/.exec(text);
  if (!m) return ["waiting", "等待扫码", ""];
  const code = m[1], redir = normU(m[3]), msg = m[5];
  if (code === "0") return ["success", msg || "扫码成功", redir];
  if (code === "65") return ["expired", "二维码已失效，请点下方刷新", ""];
  if (code === "67") return ["scanned", "已扫码，请在手机上点确认", ""];
  if (code === "66") return ["waiting", "等待扫码", ""];
  return ["waiting", msg || code, ""];
}

async function resolveCheckSig(sess: Sess, startUrl: string): Promise<Record<string, string>> {
  let current = startUrl.trim();
  const visited = new Set<string>();
  for (let i = 0; i < 5; i++) {
    if (!current || visited.has(current)) break;
    visited.add(current);
    if (current.startsWith("auth://")) return extractLoginData(current);
    const direct = extractLoginData(current);
    if (direct["openid"] && direct["access_token"]) return direct;
    let r: Response;
    try {
      r = await fetch(current, {
        headers: { "User-Agent": UA, Accept: "*/*", Referer: LOGIN_URL, Cookie: cookieHeader(sess.jar) },
        redirect: "manual",
      });
    } catch { break; }
    absorb(r, sess.jar);
    const location = r.headers.get("location")?.trim();
    if (location) {
      current = new URL(location, r.url).href;
      continue;
    }
    const body = await r.text();
    const authUrl = authUrlFromBody(body);
    if (authUrl) return extractLoginData(authUrl);
    const bodyUrl = urlFromBody(body);
    if (bodyUrl && bodyUrl !== current) { current = bodyUrl; continue; }
    return extractLoginData(body);
  }
  return {};
}

async function exchange(openid: string, access_token: string) {
  const r = await fetch(MVAL_LOGIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "User-Agent": UA,
      Cookie: "clientType=9; openid=null; access_token=null;",
    },
    body: JSON.stringify({
      clienttype: 9,
      config_params: { client_dev_name: "23117RK66C", lang_type: 0 },
      login_info: { appid: 102061775, openid, qq_info_type: 5, sig: access_token, uin: 0 },
      mappid: 10200, mcode: MCODE, source_game_zone: "agame", game_zone: "agame",
    }),
  });
  const data = await r.json() as { result?: number };
  if (data.result !== 0) throw new Error(`兑换失败 result=${data.result}`);
  const userId = deepFind(data, ["user_id", "userId", "userid", "uid_str"]);
  const tid = deepFind(data, ["wt", "tid", "ticket", "wticket"]);
  if (!userId || !tid) throw new Error("兑换响应缺少 userId/tid");
  return {
    mval: {
      userId: String(userId), tid: String(tid), openid,
      uin: Number(deepFind(data, ["uin"]) || 0), access_token,
    },
    qq: { openid, access_token },
  };
}

/* ---------- 对外路由 ---------- */

export async function startSession(env: ReauthEnv): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const sid = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sess = await fetchQr({});
  await saveSession(env, sid, sess);
  return sid;
}

function pageHtml(sid: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>掌瓦商店 · 重新授权</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px;background:#fafafa}
img{width:270px;height:270px;border:1px solid #ddd;border-radius:14px;background:#fff;padding:8px}
button{margin-top:14px;padding:10px 22px;font-size:15px;border:0;border-radius:8px;background:#2563eb;color:#fff}
#s{font-size:16px;min-height:24px;color:#333}#h{color:#888;font-size:13px}</style></head><body>
<h3>掌瓦商店 · 重新授权</h3>
<div id="h">用 QQ「扫一扫」扫下方二维码；同屏不方便就截图后在扫一扫里选「相册」识别</div>
<p><img id="q" style="display:none"></p>
<div id="s">正在生成二维码…</div>
<button onclick="refresh()">刷新二维码</button>
<script>
const sid="${sid}";
let busy=false;
async function tick(){
  if(busy)return;busy=true;
  try{
    const j=await (await fetch("/reauth/poll?sid="+sid)).json();
    document.getElementById("s").textContent=j.msg||j.status;
    if(j.status==="success"){document.getElementById("q").style.display="none";
      document.getElementById("s").textContent="✅ 续期成功！今天会自动补推商店，可以关闭本页";return;}
    if(j.status==="error"){document.getElementById("s").textContent="❌ "+(j.msg||"失败");return;}
    if(j.status==="expired"){await refresh();return;}
  }catch(e){}
  busy=false;
  setTimeout(tick,2000);
}
async function refresh(){
  document.getElementById("s").textContent="正在生成新二维码…";
  await fetch("/reauth/refresh?sid="+sid);
  const q=document.getElementById("q");q.src="/reauth/img?sid="+sid+"&t="+Date.now();
  q.onload=()=>{q.style.display="";document.getElementById("s").textContent="请扫描上方二维码（本页刷新出的新码）";};
}
// 切回本页立即检测一次
document.addEventListener("visibilitychange",()=>{if(!document.hidden)tick();});
// 只展示刷新后的新码，避免用户扫到生成链接时的旧码
refresh().then(tick);
</script></body></html>`;
}

export async function handleReauth(
  url: URL, env: ReauthEnv, onCredsSaved?: () => void,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/reauth/")) return null;
  const sid = url.searchParams.get("sid") || "";
  if (url.pathname === "/reauth/page") {
    return new Response(sid ? pageHtml(sid) : "缺少 sid", { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const sess = sid ? await loadSession(env, sid) : null;
  if (!sess) return new Response("链接已失效，请重新获取", { status: 410 });
  const now = Date.now() / 1000;
  // 空闲 30 分钟或绝对 2 小时超时（刷新二维码会顺延空闲时间）
  if (!sess.done && (now - (sess.touched || sess.created) > SESSION_TTL || now - sess.created > 7200)) {
    await dropSession(env, sid);
    return new Response("会话超时", { status: 410 });
  }

  if (url.pathname === "/reauth/img") {
    const bin = Uint8Array.from(atob(sess.png), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/reauth/refresh") {
    const fresh = await fetchQr(sess.jar);
    fresh.created = sess.created; // 绝对 2 小时上限从首次创建算
    fresh.touched = Date.now() / 1000;
    await saveSession(env, sid, fresh);
    return new Response("ok");
  }

  if (url.pathname === "/reauth/poll") {
    if (sess.done) return Response.json({ status: "success", msg: "已完成" });
    let [status, msg, successUrl] = await pollOnce(sess);
    sess.touched = Date.now() / 1000;

    // 关键修复：手机浏览器切到 QQ 后页面会被挂起，错过 QQ 的一次性"确认成功"回调。
    // 检测到"已扫码"后由服务端原地代轮询（最多 20 次×2 秒），把成功信号接住。
    if (status === "scanned") {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        [status, msg, successUrl] = await pollOnce(sess);
        if (status !== "waiting" && status !== "scanned") break;
      }
    }

    if (status === "success") {
      try {
        const qqData = await resolveCheckSig(sess, successUrl);
        if (!qqData["openid"] || !qqData["access_token"]) throw new Error("票据解析失败");
        const bundle = await exchange(qqData["openid"], qqData["access_token"]);
        await saveCreds(env, bundle);
        await dropSession(env, sid);
        onCredsSaved?.();
        return Response.json({ status: "success", msg: "续期成功" });
      } catch (e) {
        await dropSession(env, sid);
        return Response.json({ status: "error", msg: String(e) });
      }
    }
    if (status === "expired") {
      await saveSession(env, sid, sess);
      return Response.json({ status, msg });
    }
    await saveSession(env, sid, sess);
    return Response.json({ status, msg });
  }

  return null;
}
