# Windows 开机自启与升级

本项目在 Windows 上**官方只提供手动启动**（`scripts\setup.bat` / `scripts\start.bat` / 根目录 `start.bat`），**没有**内置 Windows 服务。开机自启请用任务计划程序；日常升级请用 **`scripts\update.bat`**（原地 git 更新，保留 `data\`）。

Linux 用 `scripts/install.sh`（systemd）；Docker 用容器重启策略（`docker compose pull && up -d`）。

> 说明：有人会从「事件查看器 → 将任务附加到此事件」创建任务，实际落库仍在任务计划程序里（常见路径：`任务计划程序库\Event Viewer Tasks`）。那种任务的触发器容易丢失；**推荐直接用「启动时」触发器**，更稳、更好查。

---

## 前置条件

1. 已完成首次安装：`scripts\setup.bat` 成功，能手动启动 bot
2. 确认项目根目录下存在 `dist\index.js`（`npm run build` / setup 已构建）
3. 记下两项路径：
   - **项目根目录**，例如 `D:\bots\teamspeak-music-bot`
   - **node.exe** 完整路径（PowerShell：`(Get-Command node).Source`）

---

## 图形界面配置（推荐查阅）

1. `Win + R` → 输入 `taskschd.msc` → 回车，打开 **任务计划程序**
2. 右侧 **创建基本任务…**（或「创建任务…」以看到全部选项；建议用「创建任务」）
3. **常规**
   - 名称：`TSMusicBot`（可自定）
   - 勾选：**使用最高权限运行**（可选，权限不足时再开）
   - 选：**不管用户是否登录都要运行**（bot 常驻建议此项）
   - 配置：Windows 10 / Windows Server 对应版本即可
4. **触发器** → **新建**
   - 开始任务：**启动时**
   - 建议勾选：**延迟任务时间** `30 秒`～`1 分钟`（等网络起来再连 TeamSpeak）
   - 已启用：勾选
5. **操作** → **新建**
   - 操作：**启动程序**
   - 程序或脚本：填 **node.exe 的完整路径**  
     例如 `C:\Program Files\nodejs\node.exe`
   - 添加参数：`dist\index.js`
   - 起始于：填 **项目根目录**  
     例如 `D:\bots\teamspeak-music-bot`
   - **不要**用带 `pause` 的 `start.bat` 做「是否登录都运行」的任务（无交互会话时可能异常）
6. **条件**
   - 取消：「只有在计算机使用交流电源时才启动」（笔记本尤其重要）
   - 取消：「只有在以下网络连接可用时才启动」（除非你明确需要）
   - 取消：「只有在计算机空闲时才启动」
7. **设置**
   - 勾选：「如果任务失败，立即重新启动」；可设间隔 1 分钟、尝试 3 次
   - 「如果请求的任务正在运行，则应用以下规则」：选「请勿启动新实例」
8. 确定保存（若选了「不管用户是否登录」，可能要求输入该 Windows 用户密码）

### 验证

- 在任务上右键 → **运行**，浏览器打开 `http://localhost:3000` 确认起来
- 重启电脑后，在任务计划程序查看该任务的 **上次运行时间** / **上次运行结果**（`0x0` 为成功）
- 状态「**准备就绪**」只表示任务已启用、在等触发，**不等于正在运行**

---

## PowerShell 一键创建

管理员 PowerShell（把路径改成你的实际目录）：

```powershell
$botDir = "D:\bots\teamspeak-music-bot"   # 改成项目根目录
$node   = (Get-Command node).Source

$action    = New-ScheduledTaskAction -Execute $node -Argument "dist\index.js" -WorkingDirectory $botDir
$trigger   = New-ScheduledTaskTrigger -AtStartup
# 可选：开机延迟 1 分钟
$trigger.Delay = "PT1M"

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 0)   # 不限制运行时长

Register-ScheduledTask -TaskName "TSMusicBot" -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force

Start-ScheduledTask -TaskName "TSMusicBot"
```

常用命令：

```powershell
Get-ScheduledTask -TaskName "TSMusicBot" | Format-List TaskName, State, TaskPath
Get-ScheduledTaskInfo -TaskName "TSMusicBot"   # LastRunTime / LastTaskResult
Start-ScheduledTask -TaskName "TSMusicBot"
Stop-ScheduledTask  -TaskName "TSMusicBot"
Unregister-ScheduledTask -TaskName "TSMusicBot" -Confirm:$false
```

---

## 故障排查

### 1. 触发器是空的

**直接原因：没有触发器就不会自启**，只能手动「运行」。状态仍可能是「准备就绪」。

处理：打开任务 → **触发器** → **新建** → **启动时** → 保存。

若任务在 `Event Viewer Tasks` 下且触发器丢失，可删掉旧任务，按本文重新建一条「启动时」任务。

### 2. 状态一直是「准备就绪」，重启后没起来

「准备就绪」≠ 正在运行。依次检查：

| 检查项 | 期望 |
|---|---|
| 触发器 | 至少有一条「启动时」（或你明确要的登录时/事件） |
| 常规 | 「不管用户是否登录都要运行」（无人值守开机时） |
| 条件 | 未限制交流电源 / 特定网络 / 空闲 |
| 上次运行时间 | 应接近本次开机时间 |
| 上次运行结果 | `0x0`；非 0 表示触发了但执行失败 |

```powershell
$t = Get-ScheduledTask -TaskName "TSMusicBot"
$t.Triggers
$t.Actions
Get-ScheduledTaskInfo -TaskName "TSMusicBot"
```

### 3. 触发了但 bot 没起来（LastTaskResult ≠ 0）

- `node.exe` / 工作目录路径是否改过盘符或文件夹名
- 是否误用 `start.bat`（含 `pause`）且选了「不管用户是否登录」
- 先在同一工作目录手动执行：`node dist\index.js`，确认能跑

### 4. 任务在「Event Viewer Tasks」里

这是从事件查看器「附加任务」生成的。可继续用，但务必确认触发器仍在；更建议改成标准「启动时」任务，减少依赖具体事件 ID。

---

## 与 Linux / Docker 对照

| 平台 | 开机自启方式 |
|---|---|
| Windows | 本文：任务计划程序（项目不内置） |
| Linux | `scripts/install.sh` → systemd `tsmusicbot` |
| Docker | `restart:` 策略（见 `scripts/docker/docker-compose.yml`） |

---

## 升级代码与数据保留

### 一键更新（推荐）

#### 场景 A：WSL 有 git，Windows 在别的目录跑 bot（你现在的需求）

```
WSL 仓库（只管代码 / git）
        │  sync（不覆盖 data、node_modules）
        ▼
Windows 运行目录（计划任务 + Node win32 + data/）
```

**配置文件（推荐）** — 路径、任务名都写在这里，Windows 目录改名/搬家只改这一处：

```bash
cp deploy.windows.env.example deploy.windows.env
# 编辑 deploy.windows.env：
#   TSMB_WIN_DIR=/mnt/d/你的/Windows运行目录   # 或 D:\...
#   TSMB_TASK_NAME=TSMusicBot
```

`deploy.windows.env` 已 gitignore，不会进仓库。环境变量若已设置，会覆盖文件里的同名项。仍兼容旧的单行文件 `.windows-deploy`。

以后每次升级只在 WSL 执行：

```bash
cd ~/projects/.../teamspeak-music-bot   # 你的 WSL git 目录
./scripts/update.sh
```

流程：**git pull（WSL）→ 停 Windows bot → 同步源码到 Windows 目录 → Windows 智能重建 → 重启计划任务**。

同步**不会覆盖** Windows 上的：

- `data/`（配置、数据库、Cookie）
- `node_modules/`、`web/node_modules/`、`bin/`（Windows 已编译环境）
- `dist/`、`web/dist/`（由 Windows 侧重新 `npm run build`）

只同步时（不重建）：

```bash
./scripts/sync-to-windows.sh
```

首次：Windows 目录需已有一次 `setup.bat` 装好的环境；之后日常更新复用该环境。Windows 文件夹改名或搬家时，只改 `deploy.windows.env` 里的 `TSMB_WIN_DIR`（计划任务「起始于」也要改成新路径）。

#### 场景 B：仓库就在 Windows 盘（同一目录）

**Windows：** `scripts\update.bat`  
**WSL：** `./scripts/update.sh`（转调 `update.bat`）

#### 智能重建说明

**默认不会每次全量重装环境。** 已有的 `node_modules` / 原生模块会复用；多数版本更新只跑 `npm run build`。仅在下列情况才自动跑完整 `setup`：

- `package.json` / `package-lock.json`（含 `web/`）有变化  
- `node_modules` 缺失，或原生模块与当前 Node ABI 不匹配  
- 强制：`TSMB_FULL_SETUP=1`

| 配置项 / 变量 | 作用 |
|---|---|
| `TSMB_WIN_DIR`（`deploy.windows.env`） | Windows 运行目录（可与 WSL 路径/文件夹名不同） |
| `TSMB_TASK_NAME` | 计划任务名（默认 `TSMusicBot`） |
| `TSMB_SKIP_PULL=1` | 跳过 `git pull` |
| `TSMB_NO_START=1` | 更新后不自动启动任务 |
| `TSMB_FULL_SETUP=1` | 强制完整 `setup`（最稳、最慢） |
| `TSMB_SYNC_DELETE=1` | 同步时删除 Windows 上已从仓库移除的文件（仍保护 data/node_modules） |
| `TSMB_WINDOWS=1` | WSL 下强制走 Windows `update.bat`（同目录模式） |
| `TSMB_FORCE_LINUX=1` | 强制走 Linux 逻辑 |

仅停止：

```
scripts\stop.bat          # Windows
./scripts/stop.sh         # WSL / Linux
```

### 手动等价步骤

```powershell
Stop-ScheduledTask -TaskName "TSMusicBot"   # 或 scripts\stop.bat

cd D:\bots\teamspeak-music-bot            # 改成你的项目根目录
git pull
scripts\setup.bat                         # 或手动 npm install + npm run build

Start-ScheduledTask -TaskName "TSMusicBot"
# 验证：浏览器 http://localhost:3000 ；或 Get-ScheduledTaskInfo -TaskName "TSMusicBot"
```

只要 **项目根目录路径** 和 **node.exe 路径** 没变，任务计划本身不用重建。

### 新目录 / 新 clone：沿用旧版 `data/`

若在新文件夹重新 clone，可以把旧版 setup 后产生的 **整个 `data/`** 拷到新项目根（与 `dist/`、`node_modules/` 同级），再跑 `setup.bat`。建议顺序：

1. 先停旧 bot（`scripts\stop.bat`）
2. 新目录 `git clone` + `scripts\setup.bat`
3. 复制旧版整个 `data/` 覆盖（或合并）到新目录
4. 启动并验证 WebUI；若换了路径，改任务计划里的「起始于」

| 路径 | 内容 |
|---|---|
| `data\config.json` | TS 连接、音源开关、音质、Jellyfin 等 |
| `data\tsmusicbot.db` | 机器人实例、WebUI 用户、队列、历史、identity |
| `data\cookies\` | 网易云 / QQ / B 站等登录 Cookie |
| `data\avatars\` | 自定义头像 |
| `data\local-audio\` | 本地上传的音频文件 |
| `data\spotify\` | Spotify OAuth / go-librespot（若用过） |
| `data\logs\` | 可选，仅日志 |

**不要拷贝** `node_modules\`、`dist\`、`web\dist\`——由新版 `setup.bat` 重新构建。`bin\` 里的 ffmpeg 等原生二进制也建议让 setup 按当前 Node 版本重新下载，避免 ABI 不匹配。

拷贝 `tsmusicbot.db` 前务必**先停 bot**，避免 SQLite 写入中复制导致损坏。

极旧版本可能在项目根有 `config.json`（不在 `data\` 内）；拷到新目录后，首次启动会自动迁到 `data\config.json`。

### 少数升级例外

以下情况即使保留了 `data/` 也可能需要额外操作，详见 README [更新升级](../README.md#更新升级)：

- **从 `@honeybbq/teamspeak-client 0.1.x` 升级**：旧 `identity` 可能与新版握手不兼容；连 **TS6** 时通常需清空 `bot_instances.identity` 让程序重新生成。清空后 TS 会把 bot 当作新客户端，**服务器组需按新 UID 重新授予**。
- **曾跑过 v1.10.0 初版**：`config.json` 里可能被写成 `"enabledProviders": ["jellyfin"]`，升级后在线音源仍关闭，需手动改回或删除该字段后重启。
- **从无 WebUI 鉴权的极旧版升级**：bot 数据保留，但首次打开 WebUI 会走 `/first-run` 创建管理员；浏览器需重新登录。
- **本地上传音频**：只拷数据库没拷 `data\local-audio\` 时，对应曲目会播不了。
