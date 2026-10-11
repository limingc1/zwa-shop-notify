"""QQ 扫码登录掌瓦 —— 移植自 valo-stat/server/ptlogin.py。

阶段 0 改造点（规划 2.2 / 3.2-8）：
1. extract_login_data 保留 check_sig 的**全部**字段（含 expires_in），
   valo-stat 旧版只取 5 个键、把有效期信息丢了，无法验证"QQ token 比
   掌瓦会话活得久"的假设。
2. finish() 返回 (mval凭据, qq凭据含有效期)，两者分开存。
3. 新增 renew_with_qq_token()：掌瓦 tid 过期后，用仍有效的 QQ
   access_token 静默重调 login_by_qq 换新 tid——阶段 0 核心实验。

注意：这是逆向私有协议，无官方支持，可能随时失效（与 valo-stat 相同）。
"""

from __future__ import annotations

import json
import logging
import random
import re
import time
import urllib.parse

import httpx

log = logging.getLogger("notify.qqlogin")

API_BASE = "https://app.mval.qq.com"

UA = (
    "Mozilla/5.0 (Linux; Android 12; 23117RK66C Build/V417IR; wv) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Version/4.0 Chrome/101.0.4951.61 Mobile Safari/537.36"
)

PTQR_SHOW_URL = "https://xui.ptlogin2.qq.com/ssl/ptqrshow"
PTQR_LOGIN_URL = "https://xui.ptlogin2.qq.com/ssl/ptqrlogin"
PTQR_AID = "716027609"
PTQR_DAID = "381"
PTQR_THIRD_AID = "102061775"
U1_URL = "http://connect.qq.com"

LOGIN_URL_TEMPLATE = (
    "https://xui.ptlogin2.qq.com/cgi-bin/xlogin?"
    "pt_enable_pwd=1&appid=716027609&pt_3rd_aid=102061775&daid=381"
    "&pt_skey_valid=0&style=35&force_qr=1&autorefresh=1"
    "&s_url=http%3A%2F%2Fconnect.qq.com&refer_cgi=m_authorize"
    "&ucheck=1&fall_to_wv=1&status_os=12"
    "&redirect_uri=auth%3A%2F%2Ftauth.qq.com%2F"
    "&client_id=102061775&pf=openmobile_android&response_type=token"
    "&scope=all&sdkp=a&sdkv=3.5.17.lite"
    "&sign=a6479455d3e49b597350f13f776a6288"
    "&status_machine=MjMxMTdSSzY2Qw%3D%3D&switch=1"
    "&time=1763280194&show_download_ui=true"
    "&h5sig=trobryxo8IPM0GaSQH12mowKG-CY65brFzkK7_-9EW4"
    "&loginty=6"
)

MVAL_LOGIN_URL = f"{API_BASE}/go/auth/login_by_qq?source_game_zone=agame&game_zone=agame"
MCODE = "132f0a77d34402abc8463d60100011d19b0e"

CODE_SUCCESS = "0"
CODE_EXPIRED = "65"
CODE_WAITING = "66"
CODE_SCANNED = "67"


class LoginError(Exception):
    pass


def calc_ptqrtoken(qrsig: str) -> int:
    t = 0
    for ch in qrsig:
        t += (t << 5) + ord(ch)
    return t & 2147483647


def extract_jsver(html: str) -> str:
    for pat in (
        r"/monorepo/([0-9A-Za-z]+)/ptlogin/js/login_10\.js",
        r"/monorepo/([0-9A-Za-z]+)/ptlogin/js/",
        r"https://qq-web\.cdn-go\.cn/monorepo/([0-9A-Za-z]+)",
    ):
        m = re.search(pat, html or "")
        if m:
            return m.group(1)
    return "28d22679"


def build_pt_openlogin_data(login_url: str, idt: str) -> str:
    q = urllib.parse.parse_qs(urllib.parse.urlparse(login_url).query, keep_blank_values=True)

    def gp(name: str, default: str = "") -> str:
        return (q.get(name) or [default])[0]

    items = [
        ("which", ""), ("refer_cgi", gp("refer_cgi", "m_authorize")),
        ("response_type", gp("response_type", "token")),
        ("client_id", gp("client_id", str(PTQR_THIRD_AID))),
        ("state", ""), ("display", ""), ("openapi", "1011"),
        ("switch", gp("switch", "1")), ("src", "1"),
        ("sdkv", gp("sdkv", "3.5.17.lite")), ("sdkp", gp("sdkp", "a")),
        ("tid", idt), ("pf", gp("pf", "openmobile_android")),
        ("need_pay", "0"), ("browser", "0"), ("browser_error", ""),
        ("serial", ""), ("token_key", ""),
        ("redirect_uri", gp("redirect_uri", "auth://tauth.qq.com/")),
        ("sign", gp("sign", "")), ("time", gp("time", "")),
        ("status_version", ""), ("status_os", gp("status_os", "12")),
        ("status_machine", gp("status_machine", "")),
        ("page_type", "1"), ("has_auth", "1"), ("update_auth", "1"),
        ("auth_time", str(int(time.time() * 1000))),
        ("loginfrom", ""), ("h5sig", gp("h5sig", "")),
        ("loginty", gp("loginty", "6")),
    ]
    return urllib.parse.urlencode(items)


def parse_ptui_callback(text: str) -> dict | None:
    m = re.search(r"ptuiCB\('([^']*)','([^']*)','([^']*)','([^']*)','([^']*)'", text or "")
    if not m:
        return None
    return {
        "code": m.group(1),
        "redirect_url": m.group(3).replace("\\/", "/").replace("\\x26", "&"),
        "message": m.group(5),
    }


def _norm(u: str) -> str:
    return (u or "").replace("\\/", "/").replace("\\x26", "&")


def _parse(raw: str) -> dict[str, str]:
    d: dict[str, str] = {}
    if not raw:
        return d
    for k, v in urllib.parse.parse_qs(
        raw.replace("#&", "&").lstrip("&"), keep_blank_values=True
    ).items():
        if v:
            d[k] = v[0]
    return d


def extract_login_data(url: str) -> dict:
    """解析 check_sig 票据。改造点：返回**全部**合并参数（含 expires_in），
    而不是 valo-stat 旧版裁剪后的 5 键——阶段 0 要靠它验证 QQ token 寿命。"""
    merged: dict[str, str] = {}
    visited: set[str] = set()
    queue = [_norm(url)]
    while queue:
        candidate = queue.pop(0)
        if not candidate or candidate in visited:
            continue
        visited.add(candidate)
        decoded = candidate
        for _ in range(3):
            nxt = urllib.parse.unquote(decoded)
            if nxt == decoded:
                break
            decoded = nxt
        pu = urllib.parse.urlparse(decoded)
        params: dict[str, str] = {}
        for part in (pu.query, pu.fragment):
            params.update(_parse(part))
        if not params and ("openid=" in decoded or "access_token=" in decoded):
            params.update(_parse(decoded))
        for k, v in params.items():
            merged.setdefault(k, v)
        for nk in ("u1", "url", "redirect_uri", "s_url", "jump_url"):
            nv = params.get(nk, "")
            if nv and nv not in visited:
                queue.append(_norm(nv))
    return merged


def _auth_url_from_body(body: str) -> str:
    text = _norm(body or "")
    m = re.search(r"_Callback\s*\(\s*(\{.*?\})\s*\)\s*;?\s*$", text, re.DOTALL)
    if m:
        try:
            url = json.loads(m.group(1)).get("url", "")
            if url.startswith("auth://"):
                return url
        except Exception:
            pass
    m = re.search(r"(auth://tauth\.qq\.com/[^\s\"'<>]+)", text)
    return m.group(1) if m else ""


def _url_from_body(body: str) -> str:
    text = _norm(body or "")
    for pat in (
        r"ptuiCB\('[^']*','[^']*','([^']+)'",
        r"location\.href\s*=\s*['\"]([^'\"]+)['\"]",
        r"(auth://tauth\.qq\.com/[^\s\"'<>]+)",
        r"(https?://[^\s\"'<>]*check_sig[^\s\"'<>]*)",
    ):
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return ""


def _deep_find(obj, keys, max_depth: int = 4):
    """私有接口字段层级会变，多路径兜底（同 valo-stat）。"""
    if max_depth <= 0:
        return None
    if isinstance(obj, dict):
        for k in keys:
            if k in obj and obj[k] not in (None, "", 0):
                return obj[k]
        for v in obj.values():
            found = _deep_find(v, keys, max_depth - 1)
            if found:
                return found
    elif isinstance(obj, list):
        for v in obj[:5]:
            found = _deep_find(v, keys, max_depth - 1)
            if found:
                return found
    return None


async def _mval_exchange(client: httpx.AsyncClient, openid: str, access_token: str) -> dict:
    """用 QQ 侧 openid+access_token 兑换掌瓦凭据（userId/tid/uin）。"""
    body = {
        "clienttype": 9,
        "config_params": {"client_dev_name": "23117RK66C", "lang_type": 0},
        "login_info": {
            "appid": 102061775,
            "openid": openid,
            "qq_info_type": 5,
            "sig": access_token,
            "uin": 0,
        },
        "mappid": 10200,
        "mcode": MCODE,
        "source_game_zone": "agame",
        "game_zone": "agame",
    }
    headers = {
        "Cookie": "clientType=9; openid=null; access_token=null;",
        "User-Agent": UA,
        "Content-Type": "application/json",
    }
    try:
        r = await client.post(MVAL_LOGIN_URL, headers=headers, json=body)
        data = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise LoginError(f"兑换掌瓦凭证请求失败：{e}") from e

    if data.get("result") != 0:
        raise LoginError(f"掌瓦凭证兑换失败 result={data.get('result')} {str(data)[:200]}")

    user_id = _deep_find(data, ["user_id", "userId", "userid", "uid_str"]) or ""
    tid = _deep_find(data, ["wt", "tid", "ticket", "wticket"]) or ""
    uin = _deep_find(data, ["uin"]) or 0
    if not user_id or not tid:
        raise LoginError(f"掌瓦凭证字段缺失：{str(data)[:300]}")

    return {
        "userId": str(user_id),
        "tid": str(tid),
        "openid": openid,
        "uin": uin,
        "access_token": access_token,
        "ct": _deep_find(data, ["ct"]) or "",
        "ctt": _deep_find(data, ["ctt"]) or "",
        "sk": _deep_find(data, ["sk"]) or "",
    }


class QQScanSession:
    """一次扫码登录会话：取码 → 轮询 → 兑换凭据。"""

    def __init__(self) -> None:
        self.client = httpx.AsyncClient(
            timeout=30, follow_redirects=False, headers={"User-Agent": UA}
        )
        self.login_url = LOGIN_URL_TEMPLATE
        self.login_sig = ""
        self.qrsig = ""
        self.ptqrtoken = 0
        self.jsver = "28d22679"
        self.pt_openlogin_data = ""
        self.aegis_uid = ""
        self.done = False
        self._success_url = ""

    @property
    def _base_headers(self) -> dict[str, str]:
        return {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Referer": "https://openmobile.qq.com/",
            "X-Requested-With": "com.tencent.apps.valorant",
        }

    async def fetch_qr(self) -> bytes:
        try:
            r = await self.client.get(self.login_url, headers=self._base_headers)
            html = r.text
        except httpx.HTTPError as e:
            raise LoginError(f"无法访问 QQ 登录页：{e}") from e

        self.login_sig = self.client.cookies.get("pt_login_sig", "")
        idt = self.client.cookies.get("idt", "") or str(int(time.time()))
        self.jsver = extract_jsver(html)
        self.pt_openlogin_data = build_pt_openlogin_data(self.login_url, idt)

        sip = self.client.cookies.get("pt_serverip", "")
        cip = self.client.cookies.get("pt_clientip", "")
        self.aegis_uid = f"{sip}-{cip}-4458" if sip and cip else ""

        qr_params = {
            "s": "8", "e": "0", "appid": PTQR_AID, "type": "0",
            "t": str(random.random()), "u1": U1_URL,
            "daid": PTQR_DAID, "pt_3rd_aid": PTQR_THIRD_AID,
        }
        try:
            r2 = await self.client.get(
                PTQR_SHOW_URL,
                params=qr_params,
                headers={**self._base_headers, "Referer": self.login_url, "Accept": "image/*"},
            )
        except httpx.HTTPError as e:
            raise LoginError(f"获取二维码失败：{e}") from e

        self.qrsig = self.client.cookies.get("qrsig", "")
        if not self.qrsig:
            raise LoginError("未拿到 qrsig，二维码获取失败")
        self.ptqrtoken = calc_ptqrtoken(self.qrsig)
        if r2.content[:4] != b"\x89PNG":
            raise LoginError("二维码返回内容异常（非 PNG）")
        return r2.content

    async def poll(self) -> tuple[str, str]:
        if self.done:
            return "success", "已完成"
        params = {
            "u1": U1_URL, "from_ui": "1", "type": "1", "ptlang": "2052",
            "ptqrtoken": str(self.ptqrtoken), "daid": PTQR_DAID, "aid": PTQR_AID,
            "pt_3rd_aid": PTQR_THIRD_AID, "pt_openlogin_data": self.pt_openlogin_data,
            "device": "2", "ptopt": "1", "pt_uistyle": "35", "jsver": self.jsver,
            "r": str(random.random()),
        }
        if self.login_sig:
            params["login_sig"] = self.login_sig
        if self.aegis_uid:
            params["aegis_uid"] = self.aegis_uid

        headers = {
            "User-Agent": UA + " tencent_game_emulator",
            "Referer": self.login_url,
            "Accept": "*/*",
            "X-Requested-With": "com.tencent.apps.valorant",
        }
        try:
            r = await self.client.get(PTQR_LOGIN_URL, params=params, headers=headers)
        except httpx.HTTPError as e:
            return "error", f"轮询请求失败：{e}"

        cb = parse_ptui_callback(r.text)
        if not cb:
            return "waiting", "等待扫码"
        code = cb["code"]
        if code == CODE_SUCCESS:
            self._success_url = cb["redirect_url"]
            return "success", cb.get("message", "扫码成功")
        if code == CODE_EXPIRED:
            return "expired", "二维码已失效"
        if code == CODE_SCANNED:
            return "scanned", "已扫码，请在手机上确认"
        if code == CODE_WAITING:
            return "waiting", "等待扫码"
        return "waiting", cb.get("message", code)

    async def _resolve_check_sig(self, start_url: str) -> dict:
        current = start_url.strip()
        visited: set[str] = set()
        for _ in range(5):
            if not current or current in visited:
                break
            visited.add(current)
            if current.startswith("auth://"):
                return extract_login_data(current)
            direct = extract_login_data(current)
            if direct.get("openid") and direct.get("access_token"):
                return direct
            try:
                r = await self.client.get(
                    current,
                    headers={"User-Agent": UA, "Accept": "*/*", "Referer": self.login_url},
                )
            except httpx.HTTPError:
                break
            location = (r.headers.get("Location", "") or "").strip()
            if location:
                if not location.startswith(("http", "auth://")):
                    location = urllib.parse.urljoin(str(r.url), location)
                current = location
                continue
            auth_url = _auth_url_from_body(r.text)
            if auth_url:
                return extract_login_data(auth_url)
            body_url = _url_from_body(r.text)
            if body_url and body_url != current:
                current = body_url
                continue
            return extract_login_data(r.text)
        return {}

    async def finish(self) -> tuple[dict, dict]:
        """返回 (mval凭据, qq凭据)。qq 凭据保留全部原始字段（含 expires_in）。"""
        url = self._success_url
        if not url:
            raise LoginError("没有可处理的登录票据")
        qq_data = await self._resolve_check_sig(url)
        if not qq_data.get("openid") or not qq_data.get("access_token"):
            raise LoginError("未能从票据中解析出 openid / access_token")
        mval_creds = await _mval_exchange(self.client, qq_data["openid"], qq_data["access_token"])
        self.done = True
        return mval_creds, {
            "openid": qq_data["openid"],
            "access_token": qq_data["access_token"],
            "expires_in": qq_data.get("expires_in", ""),
            "recorded_at": time.time(),
            "raw": {k: str(v) for k, v in qq_data.items()
                    if k not in ("access_token",)},  # token 本体不进 raw 副本，避免重复落盘
        }

    async def aclose(self) -> None:
        await self.client.aclose()


async def renew_with_qq_token(qq_creds: dict) -> dict:
    """阶段 0 核心实验：不扫码，用存储的 QQ access_token 直接重兑掌瓦 tid。

    成功 → 掌瓦会话寿命可延长到 QQ token 寿命；
    失败（LoginError）→ 只能回到扫码。结果无论成败都要记入历史。
    """
    openid = (qq_creds or {}).get("openid", "")
    access_token = (qq_creds or {}).get("access_token", "")
    if not openid or not access_token:
        raise LoginError("没有存储 QQ 凭据，无法静默续期")
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        return await _mval_exchange(client, openid, access_token)
