# 视频下载神器 Codex 静默接口

入口文件：D:\Program Files\自制视频下载神器\codex-download.ps1

接口不会显示主界面、通知或弹窗。任务完成后只向标准输出返回一行 JSON，并用退出码 0 表示成功、退出码 1 表示失败。

## 命令

组件自检：

    & 'D:\Program Files\自制视频下载神器\codex-download.ps1' self-test

获取标题和可选画质，不下载：

    & 'D:\Program Files\自制视频下载神器\codex-download.ps1' info 'https://example.com/video'

下载最佳画质视频：

    & 'D:\Program Files\自制视频下载神器\codex-download.ps1' download 'https://example.com/video' -Output 'D:\Downloads' -Media video -Quality best -Format mp4

下载最高不超过 1080P 的视频：

    & 'D:\Program Files\自制视频下载神器\codex-download.ps1' download 'https://example.com/video' -Output 'D:\Downloads' -Media video -Quality 1080

下载 MP3：

    & 'D:\Program Files\自制视频下载神器\codex-download.ps1' download 'https://example.com/video' -Output 'D:\Downloads' -Media audio

下载抖音或小红书图文原图：

    & 'D:\Program Files\自制视频下载神器\codex-download.ps1' download 'https://example.com/note' -Output 'D:\Downloads' -Media images

## 参数

- Command：download、info 或 self-test。
- Url：download 和 info 必填；可以是 YouTube、B站、TapTap、抖音或小红书链接。
- Output：下载目录；省略时使用当前用户的“下载\视频下载神器”目录。
- Media：auto、video、audio 或 images。auto 会自动把图文作品保存为原图。
- Quality：best 或 144 到 4320 的目标高度。数字表示选择不高于该高度的最佳可用画质。
- Format：mp4、webm 或 mp3。webm 只对 YouTube 生效。
- Index：页面包含多个视频时选择第几个，默认 1。
- TimeoutSeconds：任务超时秒数，默认 7200。
- NoCredentials：可选开关，用于可复现的无登录测试；跳过凭证迁移和已有登录资料读取。不传入时保持原来的只读复用行为。

## 运行边界

- Codex 接口自己的缓存、会话、日志和临时文件均位于当前用户的 `%LOCALAPPDATA%\shipin-xiazai-shenqi\codex-runtime`，无需管理员权限；每次任务结束后自动删除独立会话目录。
- 默认下载目录位于当前用户的“下载\视频下载神器”；调用方可以明确指定其他输出目录。
- 接口只读使用当前正式版已有的 B站、YouTube 和小红书登录凭据，不复制或输出 Cookie 值。
- 抖音和小红书继续使用软件内置的专用解析与隐藏浏览器会话。
- 使用者应确保拥有下载和使用目标内容的合法权利。
