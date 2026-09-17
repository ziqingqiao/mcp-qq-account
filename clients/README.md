# 宿主配置

`mcp-config.json` 里是一段可以直接复制的 `mcpServers` 配置。三个宿主的用法一样,只是文件位置不同。

| 宿主 | 放到哪里 |
| --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json`(Windows)或 `~/Library/Application Support/Claude/claude_desktop_config.json`(macOS)。**合并**,不要整个替换 |
| Cursor | 项目级 `.cursor/mcp.json`,或全局 `~/.cursor/mcp.json` |
| WorkBuddy | `~/.workbuddy-ai/mcp.json`,然后在**连接器管理页右上角的「自定义连接器」**点「信任」 |

改完必须**完全退出宿主再重开**——Claude Desktop 只在启动时读配置文件,关窗口不算退出。

---

## 复制之后要改两处

```jsonc
"ONEBOT_BASE_URL": "http://127.0.0.1:3000",       // ← 你的 OneBot HTTP 服务地址
"QQ_EVENT_TOKEN": "REPLACE_WITH_A_RANDOM_STRING"  // ← 换成一串随机字符
```

`QQ_EVENT_TOKEN` 必须和 OneBot 那边「HTTP 上报」里填的一致。生成一串:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

---

## 为什么这里默认 `QQ_SEND_ENABLED: false`

**这是刻意的默认值,建议先别改。**

它意味着接入之后:

- ✅ 能读消息、看历史、列会话
- ❌ `qq_send_message` 会返回一条明确的「被运维禁用,重试无用」错误

先跑一段时间,在对话里看看模型读到的消息、它是怎么理解和转述的。**确认它没有把别人说的话当成命令之后**,再把这一项改成 `"true"`,允许它替你发消息。

一旦打开,它发出的消息就是**以你的身份、别人能看见、撤不回来**的。

---

## OneBot 那边也要配

MCP 配置只管「Agent 怎么找到本服务」。消息能不能进来,还取决于 OneBot 实现那边:

| OneBot 设置 | 值 | 作用 |
| --- | --- | --- |
| HTTP 服务(HTTP Server) | 端口如 `3000` | 本服务**调它**发消息 |
| HTTP 上报(HTTP Report) | `http://127.0.0.1:8790/onebot/events` | 它**推事件**给本服务 |
| 上报的鉴权 Token | 与 `QQ_EVENT_TOKEN` 一致 | 不填则本服务收不到(会 401) |

**两个都要开。** 只开 HTTP 服务的话,能发不能收——`qq_read_messages` 永远是空的,而且不会报错。

配好后先跑:

```bash
cd /path/to/mcp-qq-account
npm run probe
```

它会明确告诉你账号通没通,以及**该把上报地址填成什么**。

---

## 关于 `command` 里的 node 路径

`mcp-config.json` 里写的是 `"command": "node"`,依赖宿主能从 `PATH` 找到 Node。

**如果宿主启动时找不到 `node`**(GUI 程序常有不完整的 `PATH`),把 `command` 换成 Node 可执行文件的**绝对路径**:

```jsonc
"command": "/absolute/path/to/node"
```

Windows 上形如 `C:\\Program Files\\nodejs\\node.exe`;macOS / Linux 上可以用 `which node` 查。
