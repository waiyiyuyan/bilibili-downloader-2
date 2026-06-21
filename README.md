# Bilibili Video Downloader

一个基于 Node.js 的 B 站视频下载工具，支持 DASH 音视频分离下载、自动合并、断点续传、Wbi 签名以及大会员画质解锁。

> ⚠️ **声明**：本项目仅供学习 Node.js、HTTP 协议及 FFmpeg 使用，请遵守 B 站用户协议，不得下载付费或版权受限内容，不得用于商业用途。

---

## ✨ 功能特性

- 🎬 **自动下载最高画质**（未登录最高 1080P，大会员可 4K）
- 📋 **手动指定画质**：使用 `-q` 参数选择清晰度（360P/480P/720P/1080P/4K 等）
- 📚 **多 P 支持**：使用 `-p` 参数下载指定分 P
- 🔒 **大会员画质解锁**：通过设置 Cookie 获取更高画质
- ⏯️ **断点续传**：下载中断后可从断点继续，避免重复下载
- 🧩 **智能合并**：自动调用 FFmpeg 合并音视频轨道
- 🍪 **Cookie 持久化**：登录状态自动保存，无需每次手动输入
- 🛡️ **Wbi 签名**：自动适配 B 站最新接口校验

---

## 📦 安装

### 1. 克隆仓库

```bash
git clone https://github.com/waiyiyuyan/bilibili-downloader.git
cd bilibili-downloader
```

### 2. 安装依赖

```bash
npm install
```

该命令将自动安装所有必需依赖，包括 `@ffmpeg-installer/ffmpeg`（无需单独安装 FFmpeg）。

---

## 🚀 快速开始

### 基本下载（无需登录）

```bash
node index.js BV1ptLX6fECu
```

也可以直接使用完整链接：

```bash
node index.js "https://www.bilibili.com/video/BV1ptLX6fECu"
```

程序会自动选择最高可用画质（普通用户最高 1080P），下载默认第一 P。

### 指定画质

```bash
node index.js BV1ptLX6fECu -q 64   # 下载 720P
node index.js BV1ptLX6fECu -q 80   # 下载 1080P
```

常用画质 ID：

| ID  | 清晰度              | 是否需要大会员 |
|-----|---------------------|----------------|
| 16  | 360P 流畅           | 否             |
| 32  | 480P 清晰           | 否             |
| 64  | 720P 高清           | 否             |
| 80  | 1080P 高清          | 否*            |
| 112 | 1080P60 高帧率      | 是             |
| 116 | 4K 超清             | 是             |
| 120 | 4K60 杜比视界       | 是             |

> *部分视频的 1080P 需要登录，未登录时可能无法获取。

### 下载指定分 P

```bash
node index.js BV1ptLX6fECu -p 2          # 下载第 2P
node index.js BV1ptLX6fECu -p 2 -q 80    # 第 2P 的 1080P
```

---

## 🔑 解锁大会员画质

若你的账号有大会员，可以设置 Cookie 以获取更高画质。

### 1. 获取 Cookie

- 在浏览器中登录 [B 站](https://www.bilibili.com)
- 按 F12 → **Application** → **Cookies** → 选择 `https://www.bilibili.com`
- 复制以下三个字段的 **Value**：
  - `SESSDATA`
  - `bili_jct`
  - `DedeUserID`

### 2. 设置 Cookie

```bash
node index.js cookie "你的SESSDATA" "你的bili_jct" "你的DedeUserID"
```

出现 `✅ 登录Cookie已保存` 即表示成功，之后下载会自动使用你的大会员权限。

---

## 📖 完整命令帮助

运行 `node index.js` 不带任何参数，将打印完整帮助信息：

```
📘 哔哩哔哩视频下载器 (B站视频下载)

用法：
  node index.js <BV号或包含BV的链接> [选项]

选项：
  -p <页码>        下载指定分P（从1开始，默认下载第1P）
  -q <画质ID>      手动指定画质（如 -q 80 指定1080P）

Cookie设置：
  node index.js cookie <SESSDATA> <bili_jct> <DedeUserID>

示例：
  node index.js BV1ptLX6fECu                  # 下载默认第1P，自动最高画质
  node index.js BV1ptLX6fECu -p 2             # 下载第2P
  node index.js BV1ptLX6fECu -q 64            # 下载720P
  node index.js BV1ptLX6fECu -p 2 -q 80       # 下载第2P的1080P
  node index.js "https://www.bilibili.com/video/BV1ptLX6fECu" -q 80   # 使用完整链接也可
```

---

## ❓ 常见问题

### 1. 合并时提示 `Cannot find ffmpeg`

请确认已正确安装 `@ffmpeg-installer/ffmpeg`，该包会自动提供 FFmpeg 二进制文件。若仍有问题，可手动下载 [ffmpeg.exe](https://ffmpeg.org/download.html) 放到项目根目录。

### 2. 下载失败，状态码 412

通常是 Wbi 签名过期或请求头不全。本工具已自动处理签名，若出现该错误，可尝试删除 `cookies.json` 后重新运行。

### 3. 视频没有声音或只有声音

说明 DASH 流未正确获取，检查网络环境是否限制了对 B 站 CDN 的访问。

### 4. Cookie 失效后怎么办？

重新从浏览器获取最新的 `SESSDATA`、`bili_jct`、`DedeUserID`，再次运行 `cookie` 命令即可。

---

## 🛠️ 技术栈

- [Node.js](https://nodejs.org/)
- [axios](https://github.com/axios/axios)
- [cheerio](https://cheerio.js.org/)
- [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg)
- [@ffmpeg-installer/ffmpeg](https://github.com/kribblo/node-ffmpeg-installer)
- [tough-cookie](https://github.com/salesforce/tough-cookie)
- [fs-extra](https://github.com/jprichardson/node-fs-extra)

---

## 📄 许可证

本项目仅供学习用途，请遵守相关平台协议。代码使用 MIT 许可证开源。

---

## ⚠️ 免责声明

本工具仅用于技术研究与学习，使用者应遵守 B 站用户协议及相关法律法规。下载付费或版权受限内容属违规行为，由此产生的任何责任由使用者自行承担。
