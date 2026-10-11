@echo off
chcp 65001 >nul
rem 部署 Worker 到 Cloudflare。
rem 密钥与账户信息全部从本地 .env 读取（.env 已被 .gitignore 排除，绝不会提交）。
rem 注意：本机开代理时，Node 需 --use-env-proxy 才能连上 Cloudflare（代理端口按本机实际改）。
cd /d "%~dp0"
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do set "%%a=%%b"
set NODE_OPTIONS=--use-env-proxy
if not defined HTTPS_PROXY set HTTPS_PROXY=http://127.0.0.1:10808
if not defined HTTP_PROXY set HTTP_PROXY=http://127.0.0.1:10808
cd worker
npx wrangler deploy
pause
