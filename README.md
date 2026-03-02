# WatchTogether

局域网/虚拟局域网同步观影工具。双方各自播放本地相同视频文件，实时同步播放进度。

## 功能

- **房间发现**: UDP 广播自动发现同网络中的房间，兼容 ZeroTier / Tailscale / 蒲公英等虚拟局域网
- **片源匹配**: 采样 SHA-256 指纹校验，确保双方使用相同视频文件
- **播放同步**: 播放/暂停/拖动进度实时同步，带版本控制防止旧状态覆盖
- **本地字幕**: 各自独立加载本地字幕文件 (SRT/VTT/ASS/SSA)，互不影响
- **mpv 播放引擎**: 原生编解码支持 HEVC/FLAC/MKV 等所有常见格式

## 前置要求

### mpv 播放器

本应用使用 mpv 作为视频播放引擎，请先安装：

**macOS:**
```bash
brew install mpv
```

**Windows:**
```bash
scoop install mpv
```

### Node.js

需要 Node.js 18+

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build
```

## 使用流程

1. 双方打开应用，输入昵称
2. 一方点击「开始共享」创建房间（可设密码）
3. 另一方在「附近房间」列表中找到并加入
4. 房主选择本地视频文件
5. 观影方选择相同的本地视频文件
6. 系统校验片源一致后，即可同步播放
7. 各自独立加载本地字幕文件

## 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| 空格 / K | 暂停/播放 |
| ← | 后退 5 秒 |
| → | 快进 5 秒 |
| J | 后退 10 秒 |
| L | 快进 10 秒 |

## 技术栈

- Electron + React + TypeScript
- mpv (via node-mpv)
- WebSocket (播放同步)
- UDP broadcast (房间发现)
- Tailwind CSS + Zustand
