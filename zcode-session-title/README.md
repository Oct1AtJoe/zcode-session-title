# zcode-session-title

ZCode 会话规范命名插件。会话**第一个回合**结束后，标题自动变成 `MMDD｜类型｜主题`。

不依赖对话模型执行：hook 脚本自己读取用户消息，通过你配置的模型接口判断类型与主题，再直接写入 ZCode 会话库。
即使对话用的是不听话的模型，命名依然生效。

## 原理

`hooks/auto-name.mjs` 挂在 `UserPromptSubmit` 上：

1. 读取 stdin 里的 `session_id`、`prompt`。
2. 会话标题已经是 `MMDD｜类型｜主题` 格式、或用户手动改过名（`title_source = 'custom'` 但不是本插件格式）→ 静默退出。
3. 否则写入临时状态文件（同会话 60 秒内只触发一次），spawn 一个后台 worker，hook 立刻退出，**不阻塞首条消息**。
4. worker 调模型拿 `{type, topic}`，写两处：
   - `~/.zcode/cli/db/db.sqlite` 的 `session.title` / `title_source = 'custom'`
   - `~/.zcode/v2/tasks-index.sqlite` 的 `tasks.title` / `cli_title`（桌面端侧栏用它渲染任务名）

模型只被调用一次，原始消息存在临时状态文件里。

## 配置（必填一次）

复用 Claude 版插件的配置即可，无需新建：

`~/.claude/plugins/claude-session-title/config.json`

如需独立配置，在 `~/.zcode/session-title/config.json` 写 Anthropic Messages 协议的接口（优先于此路径）：

```json
{
  "baseUrl": "https://your-endpoint/v1/messages",
  "apiKey": "sk-...",
  "model": "claude-haiku-4-5",
  "thinking": "disabled",
  "timeoutMs": 12000
}
```

- `apiKey` 也可以写成 `"$MY_API_KEY"`，脚本会从同名环境变量读取，密钥不会落盘。
- `thinking: "disabled"` 可选，DeepSeek 默认开思考，命名用不上还更慢。
- 没有配置文件时插件什么都不做（不报错、不命名）。

## 已知限制

- **标题不实时刷新侧栏**：ZCode 的 hook 输出只支持 `additionalContext`，没有 Claude Code 的 `sessionTitle` 字段，插件只能写库。库里的标题在 **ZCode 重启后**（或重新加载任务列表后）显示。
- 首次触发要等模型接口返回（通常 1-3 秒），后台完成，不影响对话。
- 纯图片/附件首条消息没有文本，会等下一次带文本的消息。
- 临时状态文件在系统临时目录 `zcode-session-title/` 下，60 秒内去重。

## 批量重命名已有会话

```bash
node ~/.zcode/plugins/zcode-session-title/hooks/auto-name.mjs backfill
```

扫描所有可见会话（跳过子会话、已删除会话），用首条真实用户消息命名，8 路并发。
标题已是 `MMDD｜类型｜主题` 的自动跳过；没有文本内容的消息（如 `Untitled session`）跳过。
改完需重启 ZCode，侧栏才显示新标题。

建议先备份标题：`~/.zcode/session-title/backup-titles-*.json`。

## 验证

```bash
printf '%s' '{"session_id":"<会话 id>","prompt":"登录接口偶尔500，帮我查下"}' \
  | node hooks/auto-name.mjs prompt
sleep 5
# 读库确认 session.title 变成 1106｜修复｜登录接口500排查
```

- 同一会话再触发 → 无动作。
- 手动改名（非本格式）后再触发 → 不会覆盖。
