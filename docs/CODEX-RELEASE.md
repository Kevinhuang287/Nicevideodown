# Codex 静默接口的源码与构建

`main.js` 已包含正式安装包使用的 Codex 静默调用集成。入口、接口合同与构建清单均保存在源码；正常发布不再先解包生产 `app.asar` 作为底稿。

## 构建

在源码根目录安装开发依赖后运行：

```powershell
npm run build:codex -- --output "F:\All_Project\VideoDown-builds\本次版本"
```

输出目录必须为空。构建使用固定 `@electron/asar 4.3.0`；离线环境可传入已安装的该版本模块绝对路径：

```powershell
node scripts/build-codex-release.cjs --output "<空输出目录>" --asar-module "<已安装的@electron/asar目录>"
```

输出包含 `resources/app.asar`、4个 Codex 接口文件、`release-manifest.json` 和可读 `payload/`。构建器只读取 `config/codex-release.json` 明列的代码/资源文件，不打入 node_modules、运行记录、下载文件或本机登录资料；逐项回读 ASAR 并核对 SHA-256。输出不包含 Electron、yt-dlp、FFmpeg、FFprobe、aria2 二进制；制作完整便携包时必须另外加入并逐项自检这些运行组件。

源码包保留 `nicevideodown` 开发身份；发布清单固定正式身份 `shipin-xiazai-shenqi`，防止重建改变 Electron 用户资料路径。应用、发布清单与 `codex-interface.json` 当前统一为 `2.2.1`。静默接口把运行目录放在当前用户的 LocalAppData，而不是通常不可写的 Program Files；每次调用建立独立临时会话，并由包装脚本在进程退出后删除，避免缓存、匿名会话或 yt-dlp 解包目录长期累积。

## 验证与安装边界

1. 对主进程、preload 和 renderer 执行既有语法检查。
2. 在两个空输出目录构建，两个 app.asar SHA-256 应一致。
3. 把一份构建结果放入隔离运行副本，与已验收的运行组件组合。测试将 APPDATA、LOCALAPPDATA、TEMP/TMP 指向隔离目录；不要复制真实登录资料。
4. 静默运行 `codex-download.ps1 self-test -NoCredentials`，再以同一参数验证一次授权的公开视频下载及实际媒体可解码。此参数跳过凭证迁移和已有登录资料读取；省略时沿用原接口的只读凭证复用。
5. 确認测试成功后，正式替换仍沿原部署与备份流程。本构建器不会写入 D 盘安装目录，不改账号资料或启动 GUI。

若只是维护源码合并，不需更换行为等价的现装包。当前回滚包与正式安装仍按项目总档保留。
