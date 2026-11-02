# 网络电台（Radio Provider）落地方案

> 状态：**已实现**（阶段 0–3 全部落地，另加「本地电台导入」）
> 参考实现：Traydio（MIT）— `TheJoeFin/Traydio`，仅参考逻辑，不搬代码
> 目标版本基线：`4347c07`（已同步上游 v1.15.4）

## 0. 实现现状

| 阶段 | 文件 | 说明 |
|---|---|---|
| 0 播放器 live 模式 | `src/audio/player.ts` | `play(url, seek, duration, live)`；live 时不按 EOF/欠载判定曲终（死流兜底 9000 帧 ≈ 3 分钟）；`seek()` 空操作；`resume()` 重新连接 |
| 0' 掉线重连 | `src/bot/instance.ts` `reconnectLiveStream()` | `trackEnd` / `error` 都走同一条重连路径：重新解析地址并重新 `play`，最多 5 次、1s 递增退避；成功播放满 60s 才重置预算。**不会**误跳下一台 |
| 1 `radio` provider | `src/music/radio.ts` | 4 个镜像 fallback、搜索/榜单/facets、`getPersonalFm()`（目录不可达时退化为本地导入） |
| 2 ICY 元数据 | `src/music/radio-metadata.ts` | 独立短连接解析 `StreamTitle`，含 iHeartRadio `Exploring` 变体；由 `GET /api/radio/now-playing` 使用 |
| 3 接入 | `provider.ts` / `queue.ts` / `database.ts` / `config.ts` / `web/api/*` | `-r` 热键、`GATEABLE_PROVIDERS` 含 `radio`（默认关闭）、`BotStatus.isLive`、前端直播条 |
| 附加：本地电台 | `src/music/radio-local.ts`、`src/web/api/radio.ts`、`web/src/views/Radio.vue` | M3U 导入（预览/去重/原子写）、封面编辑、分组筛选、收藏置顶、分区折叠、`data/local-radio.json` 持久化 |

与原计划的差异：

- **导入接口需要 `bot.manage`**。原计划只打算给读路由做音源开关，但导入写的是全站共享的 operator 数据，
  且导入地址由服务器去连接 —— 任何已登录用户（含游客）都不该能改。
- **导入地址禁止内网 / 本机**（`isImportableStreamUrl`）。这是 SSRF 面：`/now-playing` 会让服务器去请求任意
  导入的地址。校验只作用于新导入；手工写进 JSON 的内网电台仍可播放。
- 播放器重连是新增的第 0' 阶段：原计划只处理「ffmpeg 活着但不出数据」，而 ffmpeg 进程被网络抖动顶掉时
  播放器会**立刻**发 `trackEnd`，那才是电台最常见的掉线形态。

### 收藏电台（附加功能）

需求：目录搜索结果和「我的电台」里的电台都能收藏，并固定在页面顶部。

实现取舍：

- **收藏是 `data/local-radio.json` 行上的 `favorite` 标记**，不是第二份列表。站点地址仍是文件的主键，
  所以同一个台不会既以「目录收藏」又以「导入」出现两次。
- 从目录收藏时把整条 `RadioStation` 落盘（`imported: false`）。收藏的意义就是目录挂了也能播，
  只存一个 `stationuuid` 的话离线时既解析不到流地址、也显示不出名字。
- `GET /api/radio/local` 只返回 `imported !== false` 的行。收藏目录台不属于「我的电台」，
  但**导入的台被收藏时仍是导入行**（带 `favorite: true`），两个分区都能看到它。
  取消收藏「仅收藏」行会删除该行，取消导入行的收藏只清标记。
- 排序用 `favoritedAt`（收藏时间）倒序，最近收藏的置顶。旧文件没有该字段的行排在后面。

### 分区折叠（附加功能）

- 收藏 / 我的电台 / 正在播放 / 热门（搜索结果）以及「我的电台」的每个分组，标题即折叠开关。
- **无内容的分区默认收起**，但标题保留：功能可发现、布局不会在第一条数据到达时跳动，
  展开后显示一句提示。用户点过之后以用户选择为准。
- 折叠状态存 `localStorage('radio-collapsed-sections')`；纯逻辑在
  `web/src/views/radioSections.ts`（含旧版「数组」格式的迁移与单测），组件只负责渲染。


## 1. 需求澄清

Traydio 的 "FM" 与 bot 现有的 `!fm` **不是同一个东西**：

| | Traydio | 本 bot `!fm` |
|---|---|---|
| 本质 | 网络电台播放器（Radio Browser 目录） | 个性化推荐流（网易云/QQ/网易云每日） |
| 音源 | 直播流（MP3/AAC/HLS，永不结束） | 点播单曲（有确定时长） |
| 元数据 | ICY `StreamTitle`（实时曲目） | 平台 API 直接给 |

**结论**：不移植 Traydio 的播放器，而是新增第 9 个 provider `radio`，让它实现
`getPersonalFm()`，从而复用已有的 FM 骨架（`startFm` / `refillFm` / Random 模式 /
队列快照持久化）。这样 `!fm -r` 直接可用。

## 2. 复用现状

已存在且**无需修改**：

- `BotInstance.startFm()` / `refillFm()` — `src/bot/instance.ts`
- `!fm` 命令与音源 flag 解析（`cmdFm` → `getProvider(cmd.flags)`）
- `POST /api/player/:botId/fm`
- `GET /api/music/personal/fm`
- 队列快照持久化（`fmPlatform` 字段）

已有 3 个 `getPersonalFm()` 实现可作模板：
`src/music/netease.ts:420`、`src/music/qq.ts:887`、`src/music/jellyfin.ts:555`

## 3. 阻塞项（必须先解决）

电台是**直播流**，而 `AudioPlayer` 是为点播单曲设计的。当前会在 4 处出错：

### 3.1 播放器误判曲终

`src/audio/player.ts:760-780` 靠"缓冲区空 + ffmpeg 无输出"判定曲终：

```
MAX_EMPTY_ATTEMPTS = 250   (~5s)
MAX_STALL_ATTEMPTS = 3000  (~60s)
```

电台流永不 EOF，一旦网络抖动就会触发切歌。

**改法**：`play()` 增加 live 标志，live 时禁用这两条判定（保留"长时间无数据"兜底，
但阈值提高到如 5 分钟）。

#### 现有签名
```ts
play(url: string, seekSeconds = 0, songDuration = 0): void
```

### 3.2 进度条会跑飞

`web/src/stores/player.ts:211,242`：

```ts
const maxDuration = this.activeBot.currentSong.duration || Infinity;
```

电台 `duration` 只能是 0 → `Infinity` → elapsed 无限增长。

**改法**：`BotStatus` 增加 `isLive: boolean`，前端 live 时隐藏进度条与 seek。

### 3.3 seek 对直播有害

`src/audio/player.ts:941` 的 `seek()` 会重新 spawn ffmpeg 并加 `-ss`，对直播流结果
不可预测。

**改法**：live 模式下 `seek()` 直接 return。

### 3.4 pause/resume 会累积延迟

暂停 = 停止读 stdout → TCP 反压 → 恢复后积压几十秒。

**改法**：live 下 `resume()` 改为重连（重新 `play(currentUrl)`）而非续播。
Traydio 的做法也是断开重连。

### 3.5 流恢复逻辑不适用（已确认无需改动）

`RESUMABLE_PLATFORMS` 目前只有 `["bilibili"]`，电台自然不会进入该路径。

## 4. 实现步骤

### 阶段 0 · 播放器 live 模式

**目标**：`play(url, 0, 0, { live: true })` 能稳定播放任意直播流 2 小时。

改动点：
- `src/audio/player.ts`
  - 新增 `private isLive = false`
  - `play()` 第 4 参（options 对象，或独立 `playLive()` 方法以便测试）
  - 曲终判定加 `!this.isLive` 条件
  - `seek()` 加 `if (this.isLive) return`
  - `resume()` 加 live 分支（重连）
  - `stop()` 重置 `isLive`
- `src/bot/instance.ts`
  - `resolveAndPlay` 对 `platform === "radio"` 传 live 标志
  - `getStatus()` 增加 `isLive`
- `web/src/stores/player.ts`
  - `Source` 类型加 `'radio'`
  - `interpolateElapsed` / 进度条在 `isLive` 时特殊处理

**验收**：
- 播放 `http://streams.fluxfm.de/Chillhop/mp3-320` 2 小时不掉线
- 内存稳定（高水位 640KB 反压已存在）
- 暂停 30 秒后恢复，应重新连到当前直播点（而非回放 30 秒前的音频）

### 阶段 1 · `src/music/radio.ts`

参考 `RadioBrowserService.cs` 的参数映射（Traydio）：

```
GET https://de1.api.radio-browser.info/json/stations/search
    ?name=          &country=      &language=
    &tagList=       &codec=        &bitrateMin=
    &order=votes    &reverse=true  &hidebroken=true
    &limit=50
```

其他端点：`json/stations/byuuid/{uuid}`、`json/stations/byurl`（POST）、
`json/tags`、`json/countries`、`json/languages`。

映射到 `Song`：

| Song 字段 | 来源 |
|---|---|
| `id` | `stationuuid` |
| `name` | `name` |
| `artist` | `country` / `language` |
| `album` | `tags` |
| `duration` | `0` |
| `coverUrl` | `favicon` |
| `platform` | `"radio"` |

`getSongUrl(uuid)` → `url_resolved || url`，**必须校验协议是 http/https**。

`getPersonalFm()` → 从收藏 + 按标签/国家热门中随机取 15–20 个台。

**服务发现**：Traydio 硬编码 `de1`。建议做 `all.api.radio-browser.info` DNS 轮询
或多节点 fallback（`de1` / `de2` / `fi1`）。

### 阶段 2 · `src/music/radio-metadata.ts`（可选）

用独立 HTTP 短连接轮询 ICY 元数据（**不要**依赖 ffmpeg 的 icy 能力，不可控）：

```
请求头 Icy-MetaData: 1
→ 响应头 icy-metaint: N
→ 丢弃 N 字节音频
→ 读 1 字节长度 L（实际长度 = L × 16）
→ 读该长度内容 → 正则 StreamTitle='...'
```

兼容变体（Traydio `StreamMetadataService.cs:330` 有完整实现）：
- 标准：`StreamTitle='Artist - Song';`
- iHeartRadio：`Exploring title="Song",artist="Artist"`
- `StreamTitle='Artist - text="Song" amgArtworkURL="..."'`

**实测验证过**（FLUX FM，`icy-metaint=8192`）：
```
ICY TITLE: StreamTitle='ChillHop';
```

播报规则参考 `SongChangeAnnouncementPolicy.cs`：
- 开台 30 秒内的首次观测算"正在播放"，可播报
- 之后严格文本去重
- **默认关闭**，配置开启

### 阶段 3 · 接入

- `src/music/provider.ts`：`Platform` 加 `"radio"`
- `src/audio/queue.ts` / `src/data/database.ts`：平台联合类型同步
- `src/data/config.ts`：`GATEABLE_PROVIDERS` 加 `"radio"`（**默认关闭，opt-in**）
- `src/bot/instance.ts`：`FLAG_PLATFORMS` 加 `["r", "radio"]`
- `src/web/api/player.ts`：**6 处**平台白名单加 `"radio"`（注意这是运行时判断，
  TypeScript 挡不住）
- `src/web/api/music.ts`：`getProvider()` 加分支
- `web/src/stores/player.ts`：`Source` 联合类型
- `web/src/components/SourceTabs.vue`：`LABELS` 加 `radio: '电台'`
- 修正 `startFm` 的 `"No FM songs available (need to login first)"` —
  电台不需要登录

## 5. 不建议做的事

- 搬 `IPlaybackBackend` / `LibVlcPlaybackBackend` / `NativePlaybackBackend` —
  绑定 LibVLCSharp / WinRT，与 bot 无关
- 搬 `HlsStreamHelper` — ffmpeg 原生吃 m3u8
- 搬 `EngineHealthStore` / `PlaybackEngineSelector` — 解决 "LibVLC vs WinRT" 二选一
- 搬 `MetadataPublishGate` — 防剧透延迟，bot 不需要
- 白噪音 / 电台静电音效 / 频谱可视化

## 6. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| Radio Browser 可用性 | 公共 API，无 SLA | 多节点 fallback |
| 电台失效 | 目录里大量死链 | `hidebroken=true`；播放失败自动跳过（已有重试） |
| 版权/合规 | 公开网络电台 | 用户自行承担 |
| 直播流兼容性 | 少数 HLS/加密流 ffmpeg 解不了 | 失败即跳过，不阻塞队列 |

## 7. 工作量估算

| 阶段 | 内容 | 估算 |
|---|---|---|
| 0 | 播放器 live 模式 + 前端 | 0.5–1 天 |
| 1 | `radio.ts` provider | 1–2 天 |
| 2 | ICY 元数据（可选） | 0.5–1 天 |
| 3 | 接入与 UI | 1 天 |

**建议先只做阶段 0**：它是"能不能播电台"的前置条件，且对现有 B站/YouTube
长流也是纯收益，可独立验证、独立回滚。
