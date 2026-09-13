# Nicevideodown

Nicevideodown 是一款中文桌面端多平台媒体下载工具，支持 YouTube、B站、TapTap、抖音和小红书的视频、音频及图文内容解析与下载。

## 主要功能

- 视频链接与分享口令识别
- 可用画质和格式选择
- 抖音、小红书视频及图文下载
- 下载队列、批量任务、暂停与取消
- yt-dlp、FFmpeg 与 aria2 多线程下载支持
- B站扫码登录及账号权限画质支持
- 中文界面、中文错误与警告提示

## 直接使用

Windows 用户请从 GitHub Releases 下载便携版 ZIP，完整解压后双击 `视频下载神器.exe`。不要直接在压缩包中运行，也不要删除同目录的 DLL、`resources`、`locales`、`yt-dlp.exe`、`ffmpeg.exe` 或 `aria2c.exe`。

便携包不会包含开发者或发布者的 Cookie、登录状态、下载历史和个人配置。每台电脑首次使用时会生成自己的本地配置。

## 从源码运行

需要 Node.js 22.12 或更高版本。

```powershell
npm install
npm start
```

若需要完整下载能力，请自行从官方项目获取并放到项目根目录：

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [FFmpeg 与 FFprobe](https://ffmpeg.org/)
- [aria2](https://github.com/aria2/aria2)

## Codex 静默调用与构建

源码已包含正式静默接口；构建命令、发布身份与隔离验收见 [Codex 发布说明](docs/CODEX-RELEASE.md)。使用 `npm run test:codex` 检查接口合同，使用 `npm run build:codex -- --output <空目录>` 生成可复核的 app.asar 和外置入口。

## 隐私说明

- 仓库不提交 Cookie、令牌、登录状态、历史记录或本机路径。
- B站登录信息只保存在当前用户的本地应用数据目录。
- 平台登录不是所有下载的必需条件，但受限内容、账号专享内容或部分高清画质可能需要对应平台登录。

## 使用边界

请仅下载你有权保存和使用的内容，并遵守内容平台服务条款、著作权规定及所在地法律。平台接口和页面结构变化可能影响解析功能。

## 许可证

项目源码采用 [MIT License](LICENSE)。第三方组件许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。便携包内的 Electron、Chromium、yt-dlp、FFmpeg 和 aria2 分别遵循各自许可证。
