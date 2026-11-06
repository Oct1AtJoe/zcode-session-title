# zcode-session-title

ZCode 插件市场仓库，内含插件 **会话自动命名**（`zcode-session-title`）：
首个回合后把会话标题改成 `MMDD·类型·主题`，由 hook 调你自己配置的模型接口生成，不依赖对话模型。

## 安装

ZCode → 插件市场 → 添加 → 添加插件市场，粘贴：

```
https://github.com/Oct1AtJoe/zcode-session-title
```

然后在「个人 → dev-zcode-plugins」安装「会话自动命名」。

配置复用 `~/.claude/plugins/claude-session-title/config.json`，或新建 `~/.zcode/session-title/config.json`（Anthropic Messages 协议）。详见 [zcode-session-title/README.md](zcode-session-title/README.md)。

## 说明

ZCode 的 hook 输出没有 `sessionTitle` 字段，插件直接写入会话库与任务索引；标题在 ZCode 重启后显示。hook 需重启 ZCode 后才会被加载。
