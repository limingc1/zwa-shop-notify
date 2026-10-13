# 掌瓦每日商店微信通知（zwa-shop-notify）

个人自用的无畏契约国服「掌上无畏契约（掌瓦）」每日商店自动通知工具：
**每天北京时间 08:20，云端自动查询本人账号的当日商店，以图文卡片推送到企业微信（备用 Server酱微信推送），并支持网页版商店页与手机扫码自助续期。全程无需常开电脑。**

> ⚠️ 本项目通过逆向私有协议访问掌瓦 App 后端，仅限个人自用、低频调用。接口可能随时失效，无官方支持。
>
> 本仓库仅作个人技术记录与学习分享：与腾讯/Riot 无任何关联，不构成对官方服务条款的挑战或规避指导；不提供托管、代配置或任何形式的对外服务。请勿转发带有访问 token 的推送链接或网页版地址。

## 功能一览

| 功能 | 说明 |
|---|---|
| 每日商店推送 | 每天 08:20（主窗口，另有 09:30/12:00 补偿）（商店 08:00 刷新后）自动查询并推送，企业微信群图文卡片，图片直接可见 |
| 关注皮肤 | 命中的皮肤在卡片标题带 ⭐；在网页版商店页点 ☆/★ 或手动输入名字管理，云端即时生效 |
| 网页版商店页 | 深色卡片墙、大图、价格、想要人数；手机浏览器加桌面图标即用 |
| 登录态自愈 | 过期先用 QQ token 静默重兑（实测可用）；失败则推送"手机扫码续期"链接，全程不碰电脑 |
| 去重与报丧 | 同一商店周期（`end_ts`）只推一次；查询失败/需续期走独立通道告警 |
| 凭据加密 | 掌瓦登录凭据 AES-256-GCM 加密存于 D1，密钥在 Cloudflare Secrets；本仓库不含任何真实密钥 |

## 架构

```
（首次）本地扫码登录 → 凭据加密导入云端
                                   │
Cloudflare Workers + Cron（UTC 00:20 = 北京 08:20，另有 01:30、04:00 补偿窗口）
  ├─ 掌瓦后端 app.mval.qq.com /go/mlol_store/agame/user_store（本人每日商店）
  ├─ 过期 → 用存储的 QQ access_token 静默重兑 tid → 失败推手机扫码链接
  ├─ D1：加密凭据 / 关注列表 / 商店快照 / 去重记录 / 运行历史
  └─ 推送：企业微信群机器人（图文卡片）→ 失败降级 Server酱
```

## 目录结构

```
notify/            本地 Python 工具（阶段0验证包 + 运维 CLI）
  qq_login.py      QQ 扫码登录（xlogin → ptqrshow → 轮询 → login_by_qq 兑换）
  mval.py          掌瓦 API 客户端（商店/角色，明文 Cookie 鉴权）
  storage.py       本地凭据与历史（data/，不入库）
  cli.py           login / check / renew / run / watch / history
  deploy.py        云端运维：creds / watch / run / status / keypair
worker/            Cloudflare Worker（TypeScript）
  src/index.ts     定时主流程：查商店→续期→去重→图文推送→报丧
  src/reauth.ts    手机扫码续期（服务端代轮询，免电脑）
  schema.sql       D1 建表（kv / notified / history）
  wrangler.toml    Cron、D1 绑定、自定义域名
项目规划.md         完整规划与阶段实测记录
deploy.bat         一键部署（密钥从本地 .env 读取）
```

## 本地环境（首次）

```bash
pip install -r requirements.txt
cp .env.example .env        # 填 SENDKEY 等
python -m notify.cli login  # 手机QQ扫码 → 存凭据 → 自动验证商店
python -m notify.cli check  # 手动查一次商店
python -m notify.cli renew  # 实验：QQ token 静默重兑
```

## 部署（Cloudflare）

前置：Cloudflare 免费账号 + Workers + D1；企业微信群机器人 Webhook；（可选）Server酱 SendKey。

```bash
# 一次性：建库、建表、写密钥
npx wrangler d1 create zwa-notify                       # 记下 database_id 填入 wrangler.toml
npx wrangler d1 execute zwa-notify --remote --file=worker/schema.sql
npx wrangler secret put SENDKEY / WECOM_ROBOT_KEY / TRIGGER_TOKEN / CRED_KEY ...

# 日常部署（Windows 直接双击 deploy.bat）
cd worker && npx wrangler deploy
```

> 💡 本机开着代理时 Node 连不上 Cloudflare API，需 `NODE_OPTIONS=--use-env-proxy`（deploy.bat 已内置）。

凭据导入云端（扫码后执行）：

```bash
python -m notify.deploy creds <WORKER_URL>
python -m notify.deploy watch <WORKER_URL>
```

## 日常使用

- **看商店**：等 08:20 群卡片 / 打开网页版（`/shop?t=<token>`，建议加桌面）
- **改关注**：网页版点 ⭐ 或输入名字添加，即时生效
- **收到"需重新授权"**：复制链接到手机浏览器 → QQ 扫码 → 自动恢复并补推
- **查运行状态**：`python -m notify.deploy status <WORKER_URL>`

## 安全说明

- `.env`、`data/`（登录凭据、二维码、历史）已被 `.gitignore` 排除，仓库不含任何真实密钥；
- 云端凭据 AES-256-GCM 加密存储，密钥仅存在于 Workers Secrets；
- 续期链接 / 网页版均为随机 token 鉴权，请勿转发给他人；
- 仅限查询本人账号，不做多用户服务、不商用、不高频轮询。

## 自己搭建（fork 后必读）

### 你需要准备什么

| 材料 | 要求 | 难度 |
|---|---|---|
| 一台有 Python + Node 的电脑 | 只做首次登录和部署，之后可弃用 | ★★ |
| Cloudflare 免费账号 | 注册即用，无需信用卡 | ★ |
| 企业微信群机器人 | 手机装企业微信 App → 建群 → 群机器人 → 复制 Webhook（免认证） | ★ |
| Server酱 SendKey（可选备用） | sct.ftqq.com 微信扫码即得 | ★ |
| 你自己的 QQ | 扫码授权掌瓦登录 | — |

### Fork 之后必须改的地方（不改会部署失败或打到别人的服务上）

1. **`worker/wrangler.toml`**：
   - `name`：改成你自己的 Worker 名；
   - `routes` 里的自定义域名 `zwa.lim1ng.bond`：**删掉这两行**（那是作者的域名）。Workers 免费版自带的 `https://<名字>.<你的子域>.workers.dev` 就能用，只是国内手机访问 workers.dev 可能不稳定；若你有自己的已激活 Cloudflare 域名，换成它更好；
   - `database_id`：建库后替换成你自己的（见下）。
2. **`worker/src/index.ts` 顶部 `SELF_URL`**：改成你的 Worker 访问地址。
3. **`worker/src/index.ts` 的 `WW_verify_*.txt` 路由**：整段删掉（作者的企业微信域名验证，与你无关）。
4. **`.env`**：按 `.env.example` 建一份，填你自己的 SENDKEY；`CRED_KEY`/`TRIGGER_TOKEN` 用 `python -m notify.deploy keypair` 生成。

### 部署步骤（约 20 分钟）

```bash
# 1. 克隆并安装依赖
git clone https://github.com/<你的用户名>/zwa-shop-notify.git
cd zwa-shop-notify && pip install -r requirements.txt

# 2. 登录 Cloudflare（浏览器授权）并建数据库
cd worker
npx wrangler login
npx wrangler d1 create zwa-notify          # 把返回的 database_id 填进 wrangler.toml
npx wrangler d1 execute zwa-notify --remote --file=schema.sql

# 3. 写入密钥（每条回车后粘贴值）
npx wrangler secret put SENDKEY
npx wrangler secret put WECOM_ROBOT_KEY    # 企业微信机器人 Webhook 里 key= 后面那串
npx wrangler secret put TRIGGER_TOKEN      # keypair 生成
npx wrangler secret put CRED_KEY           # keypair 生成

# 4. 部署 Worker
npx wrangler deploy                        # 记下输出的 workers.dev 地址，回填 index.ts 的 SELF_URL 再部署一次

# 5. 首次登录掌瓦（唯一需要电脑扫码的环节）
cd ..
python -m notify.cli login                 # 手机QQ扫 data/qrcode.png → 自动验证商店

# 6. 把凭据推上云端
python -m notify.deploy creds https://<你的worker地址>
python -m notify.deploy watch https://<你的worker地址>

# 7. 手动触发一次，群里收到卡片即部署成功
python -m notify.deploy run https://<你的worker地址>
```

### 没有电脑？纯手机首次登录（进阶，未完全验证）

首次登录也可以用手机浏览器打开 `https://<你的worker地址>/reauth-link` 思路的变体：
本项目自带手机扫码续期页（`/reauth/page`），理论上首次登录同样可用——先部署好 Worker（步骤 1-4 可用手机 Termux 完成），再在手机上打开续期链接扫码即可入库。**此路径作者未实测**，建议首次用电脑跑一遍，之后全靠手机。

### 常见问题

- **`wrangler deploy` 报 `fetch failed`**：本机代理软件导致 Node 连不上 Cloudflare。设置 `NODE_OPTIONS=--use-env-proxy` 与 `HTTPS_PROXY`（参考 deploy.bat），或临时关闭代理软件；
- **8 点推送收到"人数过多"故障**：正常，系统会在 09:30 / 12:00 自动补偿重试；
- **登录态多久要扫一次码**：作者实测本机约 1 周，静默重兑可显著延长，因人而异；
- **想改推送时间**：`wrangler.toml` 的 `crons` 是 UTC（北京时间减 8 小时）。

## 已知限制

- 逆向协议可能随时失效（字段层级变化、风控策略调整）；
- 登录态寿命实测：本机约 1 周，静默重兑可显著延长，云端真实寿命观察中；
- 微信内置浏览器会拦截自定义域名链接，续期需用系统浏览器打开（推送文案已注明）。
