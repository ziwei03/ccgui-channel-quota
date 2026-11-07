# 渠道余量（channel-quota）

CC GUI 插件：在左下角状态栏显示当前会话所用渠道的余量，点一下打开面板查看所有渠道的余额 / 套餐余量、重置时间与倒计时。

- **状态栏芯片**：显示「最小窗口」的剩余百分比（或网关余额），每 90 秒自动刷新，倒计时每 15 秒重算。
- **中心页签**：按引擎分组列出全部自定义渠道，逐个展示 5 小时窗口、本周窗口或账户余额，并用颜色区分余量充足 / 偏低 / 即将用尽。
- 本地无网络依赖、无遥测，查询只发往渠道自己的域名。

当前版本：**0.2.2**

## 安装

将本目录（`main.js` + `manifest.json`）放进 CC GUI 的插件目录，或在应用内「插件 → 从目录安装」选择这个文件夹，然后重启或重载插件。

依赖：

- SDK `>= 0.3.12`
- 宿主应用 `>= 1.2.0`

## 使用

插件拿不到宿主内部的渠道配置，需要手动导入一次：

1. 打开 `%USERPROFILE%\.ccgui-next\config.json`（在文件管理器地址栏粘贴这串路径回车，用记事本打开）。
2. 全选复制内容。
3. 在插件的中心页签里粘贴到输入框，点「导入」。

宿主的硬性规则不允许把 `~/.ccgui-next`（以及 `~/.ssh`、`~/.aws`、用户主目录）授权给插件，所以「选择文件」这条路对这个目录一定失败，粘贴是唯一稳定的入口。只有在便携模式、`config.json` 恰好位于可授权目录时，「改从文件读取」才用得上。

勾选「记住这份配置」会把渠道快照存进插件自己的 KV（**含 Key 明文**，仅本地），下次打开无需重粘；点「清除已导入」即可删除。

## 支持的渠道

| 适配器 | 匹配域名 | 展示内容 |
| --- | --- | --- |
| Kimi 套餐 | `api.kimi.com`（`/coding` 路径） | 5 小时窗口 + 本周窗口 |
| 智谱 GLM 套餐 | `open.bigmodel.cn`、`bigmodel.cn`、`api.z.ai`、`z.ai` | 5 小时窗口 + 本周窗口 |
| OpenAI 兼容中继 | 兜底匹配 | 账户余额（额度 − 已用，USD） |

已知没有公开余量接口的渠道（如小米 MiMo Token 套餐）会在卡片上直接说明原因，不会静默失败。

余量颜色阈值：剩余 ≤ 10% 标红，≤ 30% 标黄，其余为绿。

## 权限说明

`manifest.json` 里声明的权限：

- `assets:directory` — 读取用户显式授权目录中的 `config.json`（备用路径）
- `events` — 监听 `session://activated`、`session://selection-changed`，让状态栏跟随当前会话的引擎
- `storage` — 保存 / 清除导入的渠道快照
- `ui:center-tab` — 注册「渠道余量」中心页签
- `ui:status-bar` — 注册左下角状态栏芯片
- `network:api.kimi.com`、`network:open.bigmodel.cn` — 查询余量所需的出网域名

Key 只在内存中使用，只作为 `Authorization` 头发往该渠道自身的域名，不写日志。若渠道域名不在 `network:` 授权列表内，卡片会提示需要在 `manifest.json` 里补上 `network:<host>` 后重新安装。

## 自定义适配器

`main.js` 里的 `ADAPTERS` 是一个数组，每项包含：

```js
{
  id: "my-relay",
  label: "我的中继",
  match: (url) => url.hostname === "relay.example.com",  // 用 URL 判断是否适用
  async run(http, url, key) {                           // http(url, headers) -> { status, json, error }
    // 返回 { state: "ok", kind: "windows", windows: [...] }
    // 或   { state: "ok", kind: "balance", amount, total, currency }
    // 或   { state: "error" | "unsupported" | "blocked", title, detail }
  },
}
```

`match: () => true` 的兜底项（OpenAI 兼容中继）会接住所有没被前面匹配到的域名。

## 文件结构

```
channel-quota/
├── manifest.json   # 插件元信息与权限声明
├── main.js         # 全部逻辑：解析、适配器、面板 UI、状态栏芯片
└── README.md
```

UI 用 `ctx.react.createElement` 直接手写样式，不引入构建步骤和第三方依赖，`main.js` 即产物。

## License

MIT
