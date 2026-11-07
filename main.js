// 渠道余量 —— 按当前引擎列出所有自定义渠道，逐个查询余额 / 套餐余量。
//
// 边界（写代码前定好的）：
// - 渠道的 baseUrl 与 Key 不在 SDK 里，只能由用户显式授权 ~/.ccgui-next 目录后
//   读 config.json 得到；Key 只留在内存里，不写插件存储、不写日志，只发往该渠道
//   自己的域名。
// - 联网只能走 ctx.bridge.invoke("plugin_http_request")，域名必须写在 manifest 的
//   network: 授权里；未授权的域名给出可执行的说明，而不是静默失败。
// - 宿主返回的渠道列表只有 id/名字，所以「当前引擎 / 当前渠道」都从 config.json
//   的 current 字段推导，会话切换只是把引擎跟着切换。

const CENTER_TAB_KEY = "board";
const CONFIG_FILE = "config.json";
const SNAPSHOT_KEY = "channelSnapshot";
/** 状态栏芯片的轮询节奏：每 15 秒看一眼，够 90 秒就重查一次。 */
const POLL_MS = 90 * 1000;
const TICK_MS = 15 * 1000;
/** 与 manifest 的 network: 声明保持一致：发送前先自查，给出人话解释。 */
const GRANTED_HOSTS = ["api.kimi.com", "open.bigmodel.cn"];
const PSEUDO_PROVIDERS = ["__local_settings_json__", "__local_config_toml__", "__disabled__"];

const ENGINE_LABELS = {
  claude: "Claude Code",
  kimi: "Kimi CLI",
  grok: "Grok CLI",
  codex: "Codex",
  pi: "Pi",
  omp: "OMP",
  dsh: "DSH",
  agy: "Antigravity",
  opencode: "OpenCode",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  minimax: "MiniMax",
  codebuddy: "CodeBuddy",
};

/** 与宿主 providers.ts 的 ENV_CONVENTION_KEYS 对齐：cc-switch 导入的老渠道把
 *  地址和 Key 放在 env / settingsConfig.env 里，平铺字段可能是空的。 */
const ENV_FIELDS = {
  claude: { baseUrl: "ANTHROPIC_BASE_URL", apiKey: "ANTHROPIC_AUTH_TOKEN", model: "ANTHROPIC_MODEL" },
  kimi: { baseUrl: "KIMI_BASE_URL", apiKey: "KIMI_API_KEY", model: "KIMI_MODEL_NAME" },
  grok: { baseUrl: "GROK_BASE_URL", apiKey: "GROK_API_KEY", model: "GROK_MODEL" },
  codex: { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY" },
  codebuddy: { baseUrl: "CODEBUDDY_BASE_URL", apiKey: "CODEBUDDY_API_KEY", model: "CODEBUDDY_MODEL" },
};

/** 明确没有公开余量接口的域名：先说清原因，再谈授权。 */
const NO_API_HOSTS = [
  {
    hosts: [
      "token-plan-cn.xiaomimimo.com",
      "token-plan-ams.xiaomimimo.com",
      "token-plan-sgp.xiaomimimo.com",
      "api.xiaomimimo.com",
    ],
    title: "小米 MiMo Token 套餐",
    detail: "官方没有提供 API 侧查询余量的接口，Token 套餐用量只能在控制台网页查看。",
  },
];

const COLORS = {
  ok: "var(--color-notification-success-foreground, #34d399)",
  warn: "#f5a623",
  danger: "var(--color-text-error-primary, #f2545b)",
  idle: "var(--color-text-tertiary, #8b8b93)",
  accent: "var(--color-accent-500, #4f8cff)",
};

// ---------------------------------------------------------------- 纯工具函数

const str = (value) => (typeof value === "string" ? value : "");

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Key 尾号：既能区分同一网关下的多个渠道，又不把密钥显示出来。 */
function tailOf(key) {
  const trimmed = str(key).trim();
  if (!trimmed) return "";
  return trimmed.length <= 4 ? "…" : `…${trimmed.slice(-4)}`;
}

function parseBaseUrl(raw) {
  const value = str(raw).trim();
  if (!value) return null;
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
}

/** 去掉末尾斜线但保留 /v1 这类版本段：中继的 billing 接口就挂在它下面。 */
function apiBaseOf(url) {
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** 引擎 id → 面板上显示的供应商名。 */
function engineLabel(engine) {
  return ENGINE_LABELS[engine] ?? engine;
}

function currencySymbol(currency) {
  const code = str(currency).toUpperCase();
  if (code === "CNY" || code === "RMB") return "¥";
  if (code === "USD") return "$";
  return code ? `${code} ` : "";
}

function money(amount, currency) {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const digits = Math.abs(amount) >= 100 ? 0 : 2;
  const sign = amount < 0 ? "-" : "";
  return `${sign}${currencySymbol(currency)}${Math.abs(amount).toFixed(digits)}`;
}

function clock(ms) {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 重置时间：今天只显示时分，跨天补上日期，过去的时间标「已过期」。 */
function resetLabel(ms) {
  if (ms == null) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (ms <= now.getTime()) return "已到期";
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return `${clock(ms)} 重置`;
  return `${date.getMonth() + 1}/${date.getDate()} ${clock(ms)} 重置`;
}

/**
 * 距离重置还有多久：≥1 小时说「x 小时 y 分钟后重置」，不足 1 小时说「x 分钟后重置」。
 * `now` 由调用方传进来，方便组件每 15 秒重算一次，也方便测。
 */
function afterLabel(ms, now = Date.now()) {
  if (ms == null || !Number.isFinite(ms)) return "";
  const diff = ms - now;
  if (diff <= 0) return "即将重置";
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const { days, hours, rest } = splitMinutes(minutes);
  if (days === 0) return rest === 0 ? `${hours} 小时后重置` : `${hours} 小时 ${rest} 分钟后重置`;
  // 超过一天就不必精确到分钟了，说清楚几天几小时就够。
  return hours === 0 ? `${days} 天后重置` : `${days} 天 ${hours} 小时后重置`;
}

/** 状态栏太窄，用紧凑写法：`2 时 13 分` / `48 分` / `3 天 5 时`。 */
function compactAfter(ms, now = Date.now()) {
  if (ms == null || !Number.isFinite(ms)) return "";
  const diff = ms - now;
  if (diff <= 0) return "待重置";
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `${minutes} 分`;
  const { days, hours, rest } = splitMinutes(minutes);
  if (days === 0) return rest === 0 ? `${hours} 时` : `${hours} 时 ${rest} 分`;
  return hours === 0 ? `${days} 天` : `${days} 天 ${hours} 时`;
}

/** 分钟数拆成「天 / 小时 / 分钟」，24 小时以上才会用到 days。 */
function splitMinutes(minutes) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return { days, hours, rest };
}

/** 用量比例：limit/used 优先，其次 limit/remaining，最后 used/(used+remaining)。 */
function usedPercentOf(row) {
  const limit = num(row.limit);
  const used = num(row.used);
  const remaining = num(row.remaining);
  if (limit != null && limit > 0) {
    if (used != null) return clamp((used / limit) * 100, 0, 100);
    if (remaining != null) return clamp(100 - (remaining / limit) * 100, 0, 100);
  }
  if (used != null && remaining != null && used + remaining > 0) {
    return clamp((used / (used + remaining)) * 100, 0, 100);
  }
  return null;
}

/** 重置时间字段各家写法不同，数字可能是秒也可能是毫秒。 */
function resetAtOf(row) {
  for (const key of ["resetTime", "reset_at", "resetAt", "reset_time", "nextResetTime", "next_reset_time"]) {
    const raw = row[key];
    if (raw == null) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return parsed;
      const asNumber = Number(raw);
      if (Number.isFinite(asNumber)) return asNumber > 1e12 ? asNumber : asNumber * 1000;
    }
  }
  return null;
}

function channelEnvOf(raw) {
  const row = raw && typeof raw === "object" ? raw : {};
  const flat = row.env && typeof row.env === "object" ? row.env : {};
  const settings = row.settingsConfig && typeof row.settingsConfig === "object" ? row.settingsConfig.env : null;
  const nested = settings && typeof settings === "object" ? settings : {};
  return { ...flat, ...nested };
}

/** config.json → 每个引擎的渠道列表（不碰 pseudo 渠道，它们不是真实渠道）。 */
function channelsOf(config) {
  const sections = [];
  if (!config || typeof config !== "object") return sections;
  for (const [engine, section] of Object.entries(config)) {
    if (!section || typeof section !== "object") continue;
    const providers = section.providers;
    if (!providers || typeof providers !== "object") continue;
    const current = str(section.current).trim();
    const channels = [];
    for (const [id, raw] of Object.entries(providers)) {
      if (PSEUDO_PROVIDERS.includes(id)) continue;
      const row = raw && typeof raw === "object" ? raw : {};
      const env = channelEnvOf(raw);
      const keys = ENV_FIELDS[engine] ?? {};
      const baseUrl = str(row.baseUrl).trim() || (keys.baseUrl ? str(env[keys.baseUrl]).trim() : "");
      const apiKey = str(row.apiKey).trim() || (keys.apiKey ? str(env[keys.apiKey]).trim() : "");
      const model = str(row.model).trim() || (keys.model ? str(env[keys.model]).trim() : "");
      channels.push({
        id,
        engine,
        name: str(row.name).trim() || id,
        baseUrl,
        apiKey,
        model,
        current: current === id,
      });
    }
    sections.push({ engine, channels, current: current || null });
  }
  // 有渠道的引擎排前面，方便默认选中；同为有渠道时保持 config.json 的顺序。
  sections.sort((a, b) => (b.channels.length > 0 ? 1 : 0) - (a.channels.length > 0 ? 1 : 0));
  return sections;
}

/**
 * 粘贴进来的 config.json 文本 → 渠道快照。错误信息直接面向用户，调用方原样展示。
 * 宿主把 ~/.ccgui-next 列为不可授权目录（assets.rs 的 denied_grant_root），
 * 所以「选文件」这条路对本应用自己的配置永远会失败，粘贴是唯一稳的入口。
 */
function sectionsFromText(text) {
  const raw = str(text).trim();
  if (!raw) throw new Error("粘贴框还是空的：先把 config.json 的内容全选复制进来。");
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`这段内容不是合法 JSON（${messageOf(error)}）。注意要复制整个文件，别只复制中间一段。`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("顶层不是 JSON 对象，这看起来不是 CC GUI 的 config.json。");
  }
  const sections = channelsOf(parsed);
  const total = sections.reduce((sum, section) => sum + section.channels.length, 0);
  if (total === 0) {
    throw new Error("解析成功但没找到任何自定义渠道：确认复制的是 CC GUI 的 config.json（里面有 providers 的那些引擎段）。");
  }
  return { sections, total, savedAt: Date.now() };
}

/** 从插件 KV 里取回上次导入的渠道快照，形状不对就当没有。 */
function restoreSections(snapshot) {
  const list = snapshot && typeof snapshot === "object" && Array.isArray(snapshot.sections) ? snapshot.sections : null;
  if (!list) return null;
  const clean = list
    .filter((section) => section && typeof section === "object" && typeof section.engine === "string")
    .map((section) => ({
      engine: section.engine,
      current: str(section.current) || null,
      channels: (Array.isArray(section.channels) ? section.channels : [])
        .filter((channel) => channel && typeof channel === "object" && typeof channel.id === "string")
        .map((channel) => ({
          id: channel.id,
          engine: section.engine,
          name: str(channel.name) || channel.id,
          baseUrl: str(channel.baseUrl),
          apiKey: str(channel.apiKey),
          model: str(channel.model),
          current: Boolean(channel.current),
        })),
    }))
    .filter((section) => section.channels.length > 0);
  return clean.length > 0 ? clean : null;
}

/** 宿主拒绝授权敏感目录时，把原因翻成人话——这句话用户一定会看到一次。 */
function friendlyError(error) {
  const text = messageOf(error);
  if (/sensitive directory/i.test(text)) {
    return "宿主拒绝授权这个目录：~/.ccgui-next（以及 ~/.ssh、~/.aws、用户主目录）属于硬性禁止授权的位置，换「选目录」或「选文件」都会失败。请改用粘贴方式导入，见下面的输入框。";
  }
  return text;
}

// ---------------------------------------------------------------- 各家解析器

/** Kimi For Coding：{ limits:[{ detail:{ limit, used, remaining, resetTime } }], usage:{…}, subType } */
function kimiQuota(json) {
  if (!json || typeof json !== "object") return null;
  const windows = [];
  const first = Array.isArray(json.limits) ? json.limits.find((item) => item && typeof item === "object") : null;
  const detail = first && first.detail && typeof first.detail === "object" ? first.detail : first;
  if (detail) {
    const used = usedPercentOf(detail);
    if (used != null) windows.push({ label: "5 小时窗口", spanHours: 5, usedPercent: used, resetAt: resetAtOf(detail) });
  }
  const usage = json.usage && typeof json.usage === "object" ? json.usage : null;
  if (usage) {
    const used = usedPercentOf(usage);
    if (used != null) windows.push({ label: "本周窗口", spanHours: 168, usedPercent: used, resetAt: resetAtOf(usage) });
  }
  if (windows.length === 0) return null;
  return { state: "ok", kind: "windows", plan: str(json.subType).trim() || null, windows };
}

/** 智谱 GLM：{ success, data:{ level, limits:[{ type, percentage, unit, nextResetTime }] } }
 *  unit 3 = 5 小时窗口，6 = 本周窗口，其它按重置时间远近补位。 */
function zhipuQuota(json) {
  if (!json || typeof json !== "object") return null;
  if (json.success === false) {
    return {
      state: "error",
      title: "智谱接口拒绝了这次查询",
      detail: str(json.msg) || str(json.message) || "success=false",
    };
  }
  const data = json.data && typeof json.data === "object" ? json.data : null;
  if (!data) return null;
  const rows = Array.isArray(data.limits) ? data.limits.filter((item) => item && typeof item === "object") : [];
  const windows = [];
  const pending = [];
  for (const row of rows) {
    const type = str(row.type).toUpperCase();
    if (type && type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT") continue;
    const used = num(row.percentage);
    if (used == null) continue;
    const entry = { usedPercent: clamp(used, 0, 100), resetAt: resetAtOf(row) };
    const unit = num(row.unit);
    if (unit === 3) windows.push({ label: "5 小时窗口", spanHours: 5, ...entry });
    else if (unit === 6) windows.push({ label: "本周窗口", spanHours: 168, ...entry });
    else pending.push(entry);
  }
  pending.sort((a, b) => (a.resetAt ?? Number.MAX_SAFE_INTEGER) - (b.resetAt ?? Number.MAX_SAFE_INTEGER));
  for (const entry of pending) {
    if (!windows.some((item) => item.label === "5 小时窗口")) windows.push({ label: "5 小时窗口", spanHours: 5, ...entry });
    else if (!windows.some((item) => item.label === "本周窗口")) windows.push({ label: "本周窗口", spanHours: 168, ...entry });
  }
  if (windows.length === 0) return null;
  const rank = (item) => (item.label === "5 小时窗口" ? 0 : 1);
  windows.sort((a, b) => rank(a) - rank(b));
  return { state: "ok", kind: "windows", plan: str(data.level).trim() || null, windows };
}

// ---------------------------------------------------------------- 适配器

const unsupported = (title, detail) => ({ state: "unsupported", title, detail });

/** 把「这条请求本身失败了」翻译成人话；2xx 返回 null 交给解析器。 */
function httpIssue(res, url) {
  if (res.error) return { state: "error", title: "请求没发出去", detail: res.error };
  if (res.status === 401 || res.status === 403) {
    return { state: "error", title: "Key 无效或没有查询权限", detail: `HTTP ${res.status} · ${url}` };
  }
  if (res.status === 429) return { state: "error", title: "被渠道限流了", detail: `HTTP 429 · ${url}` };
  if (res.status < 200 || res.status >= 300) {
    return { state: "error", title: `接口不可用（HTTP ${res.status}）`, detail: url };
  }
  return null;
}

const ADAPTERS = [
  {
    id: "kimi-coding",
    label: "Kimi 套餐",
    match: (url) => url.hostname === "api.kimi.com" && /^\/coding(\/|$)/.test(url.pathname),
    async run(http, url, key) {
      const endpoint = "https://api.kimi.com/coding/v1/usages";
      const res = await http(endpoint, { Authorization: `Bearer ${key}`, Accept: "application/json" });
      const issue = httpIssue(res, endpoint);
      if (issue) return issue;
      return kimiQuota(res.json) ?? unsupported("Kimi 余量接口没有返回用量字段", `查询地址：${endpoint}`);
    },
  },
  {
    id: "zhipu-plan",
    label: "智谱 GLM 套餐",
    match: (url) => ["open.bigmodel.cn", "bigmodel.cn", "api.z.ai", "z.ai"].includes(url.hostname),
    async run(http, url, key) {
      const endpoint = `${url.origin}/api/monitor/usage/quota/limit`;
      const accept = { Accept: "application/json", "Accept-Language": "zh-CN,zh;q=0.9" };
      let res = await http(endpoint, { Authorization: key, ...accept });
      // 不同部署对 Authorization 的写法不一致，401 时补一次 Bearer。
      if (res.status === 401 || res.status === 403) {
        res = await http(endpoint, { Authorization: `Bearer ${key}`, ...accept });
      }
      const issue = httpIssue(res, endpoint);
      if (issue) return issue;
      return zhipuQuota(res.json) ?? unsupported("智谱余量接口没有返回额度字段", `查询地址：${endpoint}`);
    },
  },
  {
    id: "openai-relay",
    label: "OpenAI 兼容中继",
    match: () => true,
    async run(http, url, key) {
      const base = apiBaseOf(url);
      const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
      const subUrl = `${base}/dashboard/billing/subscription`;
      const sub = await http(subUrl, headers);
      const issue = httpIssue(sub, subUrl);
      if (issue) return issue;
      const hard = num(sub.json?.hard_limit_usd) ?? num(sub.json?.system_hard_limit_usd);
      if (hard == null) return unsupported("这个网关没有返回额度字段", `查询地址：${subUrl}`);

      // one-api / new-api 系把累计花费放在 usage 里（单位：美分）。
      const today = new Date(Date.now() + 24 * 3600 * 1000);
      const end = today.toISOString().slice(0, 10);
      const usageUrl = `${base}/dashboard/billing/usage?start_date=2020-01-01&end_date=${end}`;
      const usage = await http(usageUrl, headers);
      const usedCents = num(usage.json?.total_usage);
      if (usedCents == null) {
        // 只知道额度、不知道已用，就不能把这些额度当成「余额」报出去。
        return unsupported("只知道额度，读不到已用金额", `额度接口返回 ${hard} USD，但 ${usageUrl} 没有给出 total_usage。`);
      }
      return {
        state: "ok",
        kind: "balance",
        amount: hard - usedCents / 100,
        total: hard,
        currency: "USD",
      };
    },
  },
];

// ---------------------------------------------------------------- 插件入口

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = ctx.react;

  /** 一次带 JSON 解析的 GET；错误折进返回值，调用方按状态码决定怎么显示。 */
  async function httpJson(url, headers) {
    try {
      const response = await ctx.bridge.invoke("plugin_http_request", {
        method: "GET",
        url,
        headers: headers ?? {},
      });
      const status = typeof response?.status === "number" ? response.status : 0;
      const body = typeof response?.body === "string" ? response.body : "";
      let json = null;
      if (body.trim()) {
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }
      }
      return { status, json };
    } catch (error) {
      return { status: 0, json: null, error: messageOf(error) };
    }
  }

  async function readConfigText(grant, relative) {
    const url = ctx.assets.directoryUrl(grant.grantId, relative);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`读取 ${relative} 失败（HTTP ${response.status}）`);
    return await response.text();
  }

  async function queryChannel(channel) {
    const url = parseBaseUrl(channel.baseUrl);
    if (!url) {
      return {
        state: "unsupported",
        title: "这个渠道没有网关地址",
        detail: "config.json 里该渠道没有 baseUrl，可能依赖 CLI 自己的登录，没有可查询的账户主体。",
      };
    }
    const noApi = NO_API_HOSTS.find((item) => item.hosts.includes(url.hostname));
    if (noApi) return { state: "unsupported", title: noApi.title, detail: noApi.detail };
    if (!GRANTED_HOSTS.includes(url.hostname)) {
      return {
        state: "blocked",
        title: `域名 ${url.hostname} 还没授权`,
        detail: `插件目前只被允许访问 ${GRANTED_HOSTS.join(" / ")}。在 manifest 的 permissions 里加上 network:${url.hostname}，再从这个目录重新安装一次即可。`,
      };
    }
    if (!channel.apiKey) {
      return {
        state: "error",
        title: "这个渠道没有 Key",
        detail: "渠道里没填 apiKey（可能走 CLI 登录），无法以它的身份查询余量。",
      };
    }
    const adapter = ADAPTERS.find((item) => item.match(url)) ?? null;
    if (!adapter) return { state: "unsupported", title: `没内置 ${url.hostname} 的余量接口`, detail: "可以在这份 main.js 的 ADAPTERS 里补一个。" };
    return await adapter.run(httpJson, url, channel.apiKey);
  }

  // -------------------------------------------------------- 共享查询结果
  //
  // 状态栏芯片和中心页签是两棵独立的组件树，但查的是同一批渠道。结果放一份
  // 共享 store：谁先查谁写，另一个直接读；同一个 key 并发只发一次请求。

  const hub = (() => {
    let state = { sections: [], source: null, results: {}, inflight: {}, pendingRefresh: null };
    const subs = new Set();
    const notify = () => {
      for (const fn of Array.from(subs)) {
        try {
          fn();
        } catch {
          /* 订阅者已卸载 */
        }
      }
    };
    const patch = (next) => {
      state = { ...state, ...next };
      notify();
    };
    const putResult = (key, value) => patch({ results: { ...state.results, [key]: value } });
    return {
      subscribe(fn) {
        subs.add(fn);
        return () => {
          subs.delete(fn);
        };
      },
      snapshot() {
        return state;
      },
      setSections(sections, source) {
        if (state.sections === sections && state.source === source) return;
        patch({ sections, source });
      },
      clearResults() {
        patch({ results: {} });
      },
      putResult,
      /** 芯片点开面板时挂一个「待刷新」：面板看到后立刻整体刷一次。 */
      requestRefresh(engine) {
        patch({ pendingRefresh: { engine: str(engine) || null, at: Date.now() } });
      },
      clearPendingRefresh() {
        if (!state.pendingRefresh) return;
        patch({ pendingRefresh: null });
      },
      query(key, channel) {
        const running = state.inflight[key];
        if (running) return running;
        // 刷新时保留上一轮结果，只打个 refreshing 标记：芯片上的数字/圆点/倒计时
        // 全程不变，避免每 90 秒闪一下「…」。第一次查（没有旧结果）才显示 loading。
        const previous = state.results[key];
        putResult(key, previous ? { ...previous, refreshing: true } : { state: "loading" });
        const task = (async () => {
          let result;
          try {
            result = await queryChannel(channel);
          } catch (error) {
            result = { state: "error", title: messageOf(error) };
          }
          const inflight = { ...state.inflight };
          delete inflight[key];
          state = {
            ...state,
            inflight,
            results: { ...state.results, [key]: { ...result, at: Date.now() } },
          };
          notify();
          return result;
        })();
        patch({ inflight: { ...state.inflight, [key]: task } });
        return task;
      },
    };
  })();

  /** 面板没打开时状态栏也要能出数：直接从 KV 里的导入快照起一次。 */
  let booted = false;
  async function bootstrapSections() {
    if (booted) return;
    booted = true;
    try {
      const snapshot = await ctx.storage.get(SNAPSHOT_KEY);
      const restored = restoreSections(snapshot);
      if (restored && hub.snapshot().sections.length === 0) {
        hub.setSections(restored, { kind: "snapshot", savedAt: num(snapshot?.savedAt) ?? Date.now() });
      }
    } catch {
      /* 读不到就等用户在面板里导入 */
    }
  }

  // -------------------------------------------------------------- 样式

  const S = {
    page: {
      height: "100%",
      overflowY: "auto",
      padding: "22px 26px 40px",
      boxSizing: "border-box",
      color: "var(--color-text-primary, #e7e7ea)",
      background: "var(--color-background-primary-default, transparent)",
      font: "13px/1.6 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    },
    header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 },
    h1: { fontSize: 17, fontWeight: 600, letterSpacing: 0.2 },
    sub: { marginTop: 4, color: "var(--color-text-tertiary, #8b8b93)", fontSize: 12 },
    headerActions: { display: "flex", alignItems: "center", gap: 10 },
    stamp: { color: "var(--color-text-tertiary, #8b8b93)", fontSize: 12 },
    btn: {
      appearance: "none",
      border: "1px solid var(--color-border-button-default, #34343a)",
      background: "var(--color-background-tertiary-default, #232327)",
      color: "var(--color-text-primary, #e7e7ea)",
      borderRadius: 7,
      padding: "5px 12px",
      font: "inherit",
      fontSize: 12,
      cursor: "pointer",
    },
    btnDisabled: {
      appearance: "none",
      border: "1px solid var(--color-border-button-default, #34343a)",
      background: "transparent",
      color: "var(--color-text-tertiary, #8b8b93)",
      borderRadius: 7,
      padding: "5px 12px",
      font: "inherit",
      fontSize: 12,
      cursor: "default",
    },
    chips: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 },
    chip: {
      appearance: "none",
      border: "1px solid var(--color-separator-border, #2c2c31)",
      background: "transparent",
      color: "var(--color-text-secondary, #a5a5ad)",
      borderRadius: 999,
      padding: "4px 12px",
      font: "inherit",
      fontSize: 12,
      cursor: "pointer",
    },
    chipOn: {
      appearance: "none",
      border: `1px solid ${COLORS.accent}`,
      background: "color-mix(in srgb, var(--color-accent-500, #4f8cff) 14%, transparent)",
      color: "var(--color-text-primary, #e7e7ea)",
      borderRadius: 999,
      padding: "4px 12px",
      font: "inherit",
      fontSize: 12,
      cursor: "pointer",
    },
    list: { marginTop: 18, display: "flex", flexDirection: "column", gap: 10 },
    card: {
      border: "1px solid var(--color-separator-border, #2c2c31)",
      borderRadius: 10,
      padding: "12px 14px 13px",
      background: "var(--color-background-secondary-default, rgba(255,255,255,0.02))",
    },
    cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
    cardTitle: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
    dot: { width: 7, height: 7, borderRadius: 999, flex: "0 0 auto" },
    name: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    badge: {
      border: "1px solid var(--color-separator-border, #2c2c31)",
      borderRadius: 5,
      padding: "0 6px",
      fontSize: 11,
      lineHeight: "17px",
      color: "var(--color-text-secondary, #a5a5ad)",
    },
    badgeOn: {
      border: "1px solid transparent",
      background: "color-mix(in srgb, var(--color-accent-500, #4f8cff) 20%, transparent)",
      color: "var(--color-text-primary, #e7e7ea)",
      borderRadius: 5,
      padding: "0 6px",
      fontSize: 11,
      lineHeight: "17px",
    },
    status: { fontSize: 12, flex: "0 0 auto" },
    meta: {
      marginTop: 5,
      color: "var(--color-text-tertiary, #8b8b93)",
      fontSize: 11.5,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    windows: { marginTop: 10, display: "flex", flexDirection: "column", gap: 7 },
    barRow: { display: "grid", gridTemplateColumns: "76px 1fr auto auto", alignItems: "center", gap: 10 },
    barLabel: { color: "var(--color-text-secondary, #a5a5ad)", fontSize: 12 },
    track: {
      height: 6,
      borderRadius: 999,
      background: "var(--color-background-tertiary-default, rgba(255,255,255,0.08))",
      overflow: "hidden",
    },
    fill: { height: "100%", borderRadius: 999, transition: "width .25s ease" },
    barValue: { fontSize: 12, fontVariantNumeric: "tabular-nums" },
    barReset: {
      color: "var(--color-text-tertiary, #8b8b93)",
      fontSize: 11.5,
      minWidth: 126,
      textAlign: "right",
      lineHeight: 1.45,
    },
    balance: { marginTop: 10, display: "flex", alignItems: "baseline", gap: 8 },
    amount: { fontSize: 22, fontWeight: 600, letterSpacing: 0.3, fontVariantNumeric: "tabular-nums" },
    amountHint: { color: "var(--color-text-tertiary, #8b8b93)", fontSize: 12 },
    note: { marginTop: 9, fontSize: 12 },
    noteTitle: { fontWeight: 500 },
    noteDetail: { color: "var(--color-text-tertiary, #8b8b93)", marginTop: 2, fontSize: 11.5, wordBreak: "break-all" },
    banner: {
      marginTop: 16,
      padding: "10px 12px",
      borderRadius: 8,
      border: "1px solid var(--color-border-error-default, #5a2b2f)",
      background: "color-mix(in srgb, var(--color-text-error-primary, #f2545b) 8%, transparent)",
      color: "var(--color-text-primary, #e7e7ea)",
      fontSize: 12,
    },
    empty: {
      marginTop: 28,
      padding: "22px 20px",
      border: "1px dashed var(--color-separator-border, #2c2c31)",
      borderRadius: 10,
      maxWidth: 560,
    },
    emptyTitle: { fontWeight: 600, marginBottom: 6 },
    emptyBody: { color: "var(--color-text-secondary, #a5a5ad)", fontSize: 12, marginBottom: 14 },
    importBox: {
      border: "1px solid var(--color-separator-border, #2c2c31)",
      borderRadius: 10,
      padding: "14px 16px 15px",
      marginTop: 16,
      background: "var(--color-background-secondary-default, rgba(255,255,255,0.02))",
      maxWidth: 640,
    },
    textarea: {
      width: "100%",
      boxSizing: "border-box",
      minHeight: 118,
      resize: "vertical",
      border: "1px solid var(--color-border-button-default, #34343a)",
      borderRadius: 7,
      padding: "8px 10px",
      background: "var(--color-background-primary-default, rgba(0,0,0,0.2))",
      color: "var(--color-text-primary, #e7e7ea)",
      font: "11.5px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace",
      outline: "none",
    },
    checkRow: {
      display: "flex",
      alignItems: "flex-start",
      gap: 8,
      marginTop: 10,
      color: "var(--color-text-tertiary, #8b8b93)",
      fontSize: 11.5,
      cursor: "pointer",
    },
    row: { display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" },
    barResetAfter: { color: "var(--color-text-secondary, #a5a5ad)", fontSize: 11 },
    chipBtn: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      height: 24,
      padding: "0 9px",
      boxSizing: "border-box",
      appearance: "none",
      border: "1px solid var(--color-separator-border, #2c2c31)",
      borderRadius: 999,
      background: "transparent",
      color: "var(--color-text-secondary, #a5a5ad)",
      font: "inherit",
      fontSize: 11,
      lineHeight: 1,
      whiteSpace: "nowrap",
      cursor: "pointer",
    },
    chipDot: { width: 6, height: 6, borderRadius: 999, flex: "0 0 auto" },
    chipValue: { fontVariantNumeric: "tabular-nums", fontWeight: 600 },
    chipAfter: { color: "var(--color-text-tertiary, #8b8b93)", fontSize: 10.5, whiteSpace: "nowrap" },
    footer: {
      marginTop: 22,
      paddingTop: 12,
      borderTop: "1px solid var(--color-separator-border, #2c2c31)",
      display: "flex",
      alignItems: "center",
      gap: 12,
      color: "var(--color-text-tertiary, #8b8b93)",
      fontSize: 11.5,
    },
    footerPath: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
    linkBtn: {
      appearance: "none",
      border: "none",
      background: "transparent",
      color: "var(--color-text-secondary, #a5a5ad)",
      font: "inherit",
      fontSize: 11.5,
      cursor: "pointer",
      padding: 0,
    },
  };

  // -------------------------------------------------------------- 小组件

  function Icon({ className }) {
    return h(
      "svg",
      {
        className,
        viewBox: "0 0 24 24",
        width: 16,
        height: 16,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.7,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      },
      h("path", { d: "M4 19V5" }),
      h("path", { d: "M8 19v-7" }),
      h("path", { d: "M12 19V9" }),
      h("path", { d: "M16 19v-4" }),
      h("path", { d: "M20 19V7" }),
    );
  }

  function WindowBar({ item, now }) {
    const left = clamp(100 - item.usedPercent, 0, 100);
    const color = left <= 10 ? COLORS.danger : left <= 30 ? COLORS.warn : COLORS.ok;
    const reset = resetLabel(item.resetAt);
    const after = afterLabel(item.resetAt, now);
    return h(
      "div",
      { style: S.barRow },
      h("span", { style: S.barLabel }, item.label),
      h("div", { style: S.track }, h("div", { style: { ...S.fill, width: `${left}%`, background: color } })),
      h("span", { style: { ...S.barValue, color } }, `剩 ${Math.round(left)}%`),
      h(
        "div",
        { style: S.barReset },
        reset ? h("div", null, reset) : null,
        after ? h("div", { style: S.barResetAfter }, after) : null,
      ),
    );
  }

  /** 渠道卡的状态色与头顶文案。 */
  function toneOf(result) {
    if (!result) return { color: COLORS.idle, label: "未查询" };
    if (result.state === "loading") return { color: COLORS.idle, label: "查询中…" };
    if (result.state === "error") return { color: COLORS.danger, label: "查询失败" };
    if (result.state === "blocked") return { color: COLORS.warn, label: "待授权域名" };
    if (result.state === "unsupported") return { color: COLORS.idle, label: "无接口" };
    if (result.kind === "balance") {
      const low = result.total != null && result.total > 0 && result.amount / result.total <= 0.15;
      return { color: low ? COLORS.warn : COLORS.ok, label: low ? "余额偏低" : "可查询" };
    }
    const left = Math.min(...result.windows.map((item) => 100 - item.usedPercent));
    if (left <= 10) return { color: COLORS.danger, label: "即将用尽" };
    if (left <= 30) return { color: COLORS.warn, label: "余量偏低" };
    return { color: COLORS.ok, label: "余量充足" };
  }

  function ResultBody({ result, now }) {
    if (!result) return h("div", { style: { ...S.note, color: COLORS.idle } }, "点击右上角「刷新」查询。");
    if (result.state === "loading") return h("div", { style: { ...S.note, color: COLORS.idle } }, "正在请求渠道接口…");
    if (result.state === "ok" && result.kind === "windows") {
      return h(
        "div",
        { style: S.windows },
        result.windows.map((item) => h(WindowBar, { key: item.label, item, now })),
      );
    }
    if (result.state === "ok" && result.kind === "balance") {
      return h(
        "div",
        { style: S.balance },
        h("span", { style: S.amount }, money(result.amount, result.currency)),
        result.total != null
          ? h("span", { style: S.amountHint }, `/ 额度 ${money(result.total, result.currency)}`)
          : null,
      );
    }
    const color = result.state === "error" ? COLORS.danger : result.state === "blocked" ? COLORS.warn : COLORS.idle;
    return h(
      "div",
      { style: S.note },
      h("div", { style: { ...S.noteTitle, color } }, result.title ?? "查不到余量"),
      result.detail ? h("div", { style: S.noteDetail }, result.detail) : null,
    );
  }

  // -------------------------------------------------------------- 主面板

  function Board() {
    const [ready, setReady] = useState(false);
    // { kind: "snapshot", savedAt } | { kind: "file", grant, relative } | null
    const [source, setSource] = useState(null);
    const [sections, setSections] = useState([]);
    const [manualEngine, setManualEngine] = useState(null);
    const [followEngine, setFollowEngine] = useState(null);
    const hubState = useSyncExternalStore(hub.subscribe, hub.snapshot, hub.snapshot);
    const results = hubState.results;
    const [now, setNow] = useState(() => Date.now());
    const [busy, setBusy] = useState(false);
    const [configError, setConfigError] = useState(null);
    const [loadedAt, setLoadedAt] = useState(0);
    const [importText, setImportText] = useState("");
    const [importOpen, setImportOpen] = useState(false);
    const [remember, setRemember] = useState(true);
    const busyRef = useRef(false);
    busyRef.current = busy;

    const activeEngine = useMemo(() => {
      const wanted = manualEngine ?? followEngine;
      if (wanted && sections.some((item) => item.engine === wanted)) return wanted;
      return sections[0]?.engine ?? wanted ?? null;
    }, [manualEngine, followEngine, sections]);

    const activeSection = useMemo(
      () => sections.find((item) => item.engine === activeEngine) ?? null,
      [sections, activeEngine],
    );

    const loadFromGrant = useCallback(async (target, relative) => {
      setConfigError(null);
      try {
        const text = await readConfigText(target, relative);
        const parsed = sectionsFromText(text);
        setSections(parsed.sections);
        hub.clearResults();
        setSource({ kind: "file", grant: target, relative });
        setLoadedAt(parsed.savedAt);
      } catch (error) {
        setConfigError(friendlyError(error));
      }
    }, []);

    // 上次导入过快照就直接用；没有才退回「某个已授权目录里的 config.json」。
    useEffect(() => {
      let alive = true;
      void (async () => {
        try {
          const [snapshot, grants] = await Promise.all([
            ctx.storage.get(SNAPSHOT_KEY).catch(() => null),
            ctx.assets.listDirectories().catch(() => []),
          ]);
          if (!alive) return;
          const restored = restoreSections(snapshot);
          if (restored) {
            const savedAt = num(snapshot?.savedAt) ?? Date.now();
            setSections(restored);
            setSource({ kind: "snapshot", savedAt });
            setLoadedAt(savedAt);
            setReady(true);
            return;
          }
          const list = Array.isArray(grants) ? grants : [];
          const candidates = list.filter((item) => item && typeof item.grantId === "string");
          setReady(true);
          // 便携模式/自定义数据目录时 config.json 可能在可授权的位置，试一下。
          for (const candidate of candidates) {
            try {
              const text = await readConfigText(candidate, CONFIG_FILE);
              const parsed = sectionsFromText(text);
              if (!alive) return;
              setSections(parsed.sections);
              setSource({ kind: "file", grant: candidate, relative: CONFIG_FILE });
              setLoadedAt(parsed.savedAt);
              return;
            } catch {
              /* 这个目录没有 config.json，换下一个 */
            }
          }
        } catch (error) {
          if (!alive) return;
          setConfigError(friendlyError(error));
          setReady(true);
        }
      })();
      return () => {
        alive = false;
      };
    }, []);

    // 会话切换时把引擎跟着切过去；用户手动点过芯片后就不再抢。
    useEffect(() => {
      const apply = (payload) => {
        if (!payload || typeof payload !== "object") return;
        const engine = str(payload.engine);
        if (engine) setFollowEngine(engine);
      };
      const offs = [
        ctx.events.on("session://activated", apply),
        ctx.events.on("session://selection-changed", apply),
      ];
      return () => {
        for (const off of offs) {
          try {
            off();
          } catch {
            /* 已卸载 */
          }
        }
      };
    }, []);

    const refresh = useCallback(async (engine, section) => {
      if (!engine || !section || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        for (const channel of section.channels) {
          await hub.query(`${engine}:${channel.id}`, channel);
        }
        setLoadedAt(Date.now());
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    }, []);

    // 点状态栏芯片时 hub 里会挂一个 pendingRefresh：面板一挂载就整体刷一次。
    useEffect(() => {
      const pending = hubState.pendingRefresh;
      if (!pending) return;
      const wanted = pending.engine;
      const target = (wanted ? sections.find((item) => item.engine === wanted) : null) ?? activeSection;
      // 配置还没从 KV 里读出来时先别消费掉，等 sections 到了再刷。
      if (!target) return;
      hub.clearPendingRefresh();
      if (target.channels.length > 0) void refresh(target.engine, target);
    }, [hubState.pendingRefresh, sections, activeSection, refresh]);

    // 面板读到的配置同步给共享 store，状态栏芯片才有渠道可查。
    useEffect(() => {
      hub.setSections(sections, source);
    }, [sections, source]);

    // 倒计时要自己走：每 15 秒重算一次「x 小时后重置」。
    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), TICK_MS);
      return () => clearInterval(timer);
    }, []);

    // 切到还没查过的引擎时自动查一次。
    useEffect(() => {
      if (!activeEngine || !activeSection || activeSection.channels.length === 0) return;
      const known = activeSection.channels.some((channel) => results[`${activeEngine}:${channel.id}`]);
      if (!known) void refresh(activeEngine, activeSection);
    }, [activeEngine, activeSection, refresh, results]);

    /** 粘贴导入：解析 → 落盘（可选）→ 立刻可用。 */
    const importConfig = (text) => {
      setConfigError(null);
      try {
        const parsed = sectionsFromText(text);
        setSections(parsed.sections);
        hub.clearResults();
        setSource({ kind: "snapshot", savedAt: parsed.savedAt });
        setLoadedAt(parsed.savedAt);
        setImportText("");
        setImportOpen(false);
        if (remember) {
          void ctx.storage.set(SNAPSHOT_KEY, { savedAt: parsed.savedAt, sections: parsed.sections }).catch(() => {});
        } else {
          void ctx.storage.delete(SNAPSHOT_KEY).catch(() => {});
        }
      } catch (error) {
        setConfigError(messageOf(error));
      }
    };

    /** 备用路径：config.json 恰好在可授权的位置（便携模式放 D 盘之类）。 */
    const pickConfigFile = async () => {
      setConfigError(null);
      try {
        const picked = await ctx.assets.grantFile({
          title: "选择 config.json（~/.ccgui-next 会被宿主拒绝，别选那里）",
          filters: [{ name: "CC GUI 配置", extensions: ["json"] }],
        });
        if (!picked) return;
        await loadFromGrant(picked, picked.relativePath || CONFIG_FILE);
      } catch (error) {
        const message = messageOf(error);
        if (!/cancel/i.test(message)) setConfigError(friendlyError(error));
      }
    };

    /** 清掉存下来的渠道快照（含 Key）。 */
    const forget = async () => {
      await ctx.storage.delete(SNAPSHOT_KEY).catch(() => {});
      setSections([]);
      hub.clearResults();
      setSource(null);
      setLoadedAt(0);
      setConfigError(null);
      setImportOpen(true);
    };

    const selectEngine = (engine) => {
      setManualEngine(engine);
      setFollowEngine(null);
    };

    const importPanel = () =>
      h(
        "div",
        { style: S.importBox },
        h("div", { style: S.emptyTitle }, "粘贴 config.json 的内容"),
        h(
          "div",
          { style: S.emptyBody },
          "宿主的硬性规则：~/.ccgui-next（以及 ~/.ssh、~/.aws、用户主目录）不允许授权给插件，所以「选择文件」必然被拒绝。改成复制粘贴：在文件管理器地址栏输入 %USERPROFILE%\\.ccgui-next 回车，用记事本打开 config.json，Ctrl+A、Ctrl+C，粘到下面。",
        ),
        h("textarea", {
          style: S.textarea,
          value: importText,
          spellCheck: false,
          rows: 7,
          placeholder: '{\n  "claude": { "current": "…", "providers": { … } },\n  "codex": { … }\n}',
          onChange: (event) => setImportText(event.target.value),
        }),
        h(
          "label",
          { style: S.checkRow },
          h("input", {
            type: "checkbox",
            checked: remember,
            onChange: (event) => setRemember(event.target.checked),
          }),
          h(
            "span",
            null,
            "记住这份配置（存进插件自己的 KV，含 Key 明文，下次打开不用重粘；随时可点下面的「清除」删除）",
          ),
        ),
        h(
          "div",
          { style: S.row },
          h(
            "button",
            {
              type: "button",
              style: importText.trim() ? S.btn : S.btnDisabled,
              disabled: !importText.trim(),
              onClick: () => importConfig(importText),
            },
            "导入",
          ),
          h("button", { type: "button", style: S.linkBtn, onClick: () => void pickConfigFile() }, "改从文件读取…"),
          source || importOpen
            ? h("button", { type: "button", style: S.linkBtn, onClick: () => { setImportOpen(false); setImportText(""); } }, "收起")
            : null,
        ),
      );

    if (!ready) {
      return h("div", { style: S.page }, h("div", { style: S.sub }, "正在读取插件数据…"));
    }

    if (!source) {
      return h(
        "div",
        { style: S.page },
        h("div", { style: S.h1 }, "渠道余量"),
        h(
          "div",
          { style: S.empty },
          h("div", { style: S.emptyTitle }, "导入一次渠道配置"),
          h(
            "div",
            { style: S.emptyBody },
            "插件读不到宿主内部的渠道配置，只能由你把 config.json 的内容给它。导入后按引擎列出所有自定义渠道，再逐个查余额或套餐余量。",
          ),
          importPanel(),
        ),
        configError ? h("div", { style: S.banner }, configError) : null,
      );
    }

    const officialOnly = activeSection ? !activeSection.current || PSEUDO_PROVIDERS.includes(activeSection.current) : false;
    const channels = activeSection?.channels ?? [];

    return h(
      "div",
      { style: S.page },
      h(
        "div",
        { style: S.header },
        h(
          "div",
          null,
          h("div", { style: S.h1 }, "渠道余量"),
          h(
            "div",
            { style: S.sub },
            activeSection
              ? `${engineLabel(activeSection.engine)} · ${channels.length} 个渠道`
              : activeEngine
                ? `${engineLabel(activeEngine)} · 没有自定义渠道`
                : "配置里还没有任何自定义渠道",
          ),
        ),
        h(
          "div",
          { style: S.headerActions },
          loadedAt ? h("span", { style: S.stamp }, `更新于 ${clock(loadedAt)}`) : null,
          h(
            "button",
            {
              type: "button",
              style: busy || !activeSection ? S.btnDisabled : S.btn,
              disabled: busy || !activeSection,
              onClick: () => void refresh(activeEngine, activeSection),
            },
            busy ? "查询中…" : "刷新",
          ),
        ),
      ),

      sections.filter((item) => item.channels.length > 0).length > 1
        ? h(
            "div",
            { style: S.chips },
            sections
              .filter((item) => item.channels.length > 0)
              .map((item) =>
                h(
                  "button",
                  {
                    key: item.engine,
                    type: "button",
                    style: item.engine === activeEngine ? S.chipOn : S.chip,
                    onClick: () => selectEngine(item.engine),
                  },
                  `${engineLabel(item.engine)} ${item.channels.length}`,
                ),
              ),
          )
        : null,

      configError ? h("div", { style: S.banner }, configError) : null,

      officialOnly
        ? h(
            "div",
            { style: { ...S.banner, borderColor: "var(--color-separator-border, #2c2c31)" } },
            "这个引擎当前走的是官方配置（没有启用自定义渠道），下面的渠道都没有在用。",
          )
        : null,

      channels.length === 0
        ? h(
            "div",
            { style: S.empty },
            h("div", { style: S.emptyTitle }, "这个引擎没有自定义渠道"),
            h("div", { style: S.emptyBody }, "在设置 → 供应商渠道里添加一个，再回来刷新。"),
          )
        : h(
            "div",
            { style: S.list },
            channels.map((channel) => {
              const result = results[`${activeEngine}:${channel.id}`] ?? null;
              const tone = toneOf(result);
              return h(
                "div",
                { key: channel.id, style: S.card },
                h(
                  "div",
                  { style: S.cardHead },
                  h(
                    "div",
                    { style: S.cardTitle },
                    h("span", { style: { ...S.dot, background: tone.color } }),
                    h("span", { style: S.name }, channel.name),
                    channel.current ? h("span", { style: S.badgeOn }, "当前") : null,
                    result?.kind === "windows" && result.plan ? h("span", { style: S.badge }, result.plan) : null,
                  ),
                  h("span", { style: { ...S.status, color: tone.color } }, tone.label),
                ),
                h(
                  "div",
                  { style: S.meta },
                  [
                    parseBaseUrl(channel.baseUrl)?.host ?? "无 baseUrl",
                    channel.model,
                    channel.apiKey ? `key ${tailOf(channel.apiKey)}` : "无 Key",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ),
                h(ResultBody, { result, now }),
              );
            }),
          ),

      importOpen ? importPanel() : null,

      h(
        "div",
        { style: S.footer },
        h(
          "span",
          { style: S.footerPath },
          source.kind === "file"
            ? `配置来源：${source.grant.path}\\${source.relative}`
            : `配置来源：手动导入 · ${source.savedAt ? clock(source.savedAt) : "本次会话"}（渠道或 Key 改了要重新导入）`,
        ),
        source.kind === "file"
          ? h(
              "button",
              { type: "button", style: S.linkBtn, onClick: () => void loadFromGrant(source.grant, source.relative) },
              "重新读取",
            )
          : null,
        h("button", { type: "button", style: S.linkBtn, onClick: () => setImportOpen(true) }, "重新导入…"),
        h(
          "button",
          { type: "button", style: S.linkBtn, onClick: () => void forget() },
          source.kind === "snapshot" ? "清除已导入" : "换一份配置…",
        ),
      ),
    );
  }

  // 芯片主指标取「最小窗口」（时长最短的那个，通常是 5 小时窗口）：
  // 短窗口最先见底，提前知道比等一周的窗口报警有用。没有时长信息时退回第一个。
  function focusWindow(result) {
    if (!result || result.state !== "ok" || result.kind !== "windows" || result.windows.length === 0) return null;
    let best = null;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (const item of result.windows) {
      const span = num(item.spanHours);
      if (span == null || span <= 0 || span >= bestSpan) continue;
      best = item;
      bestSpan = span;
    }
    return best ?? result.windows[0];
  }

  // -------------------------------------------------------------- 状态栏芯片
  //
  // 显示「当前会话所用渠道」的余量：数字本身每 90 秒重查一次，倒计时每 15 秒
  // 重算一次；点一下直接打开中心页签看全部渠道。

  function Chip() {
    const hubState = useSyncExternalStore(hub.subscribe, hub.snapshot, hub.snapshot);
    const [engine, setEngine] = useState(null);
    const [providerId, setProviderId] = useState(null);
    const [now, setNow] = useState(() => Date.now());
    const targetRef = useRef(null);

    useEffect(() => {
      void bootstrapSections();
    }, []);

    useEffect(() => {
      const apply = (payload) => {
        if (!payload || typeof payload !== "object") return;
        const nextEngine = str(payload.engine);
        if (nextEngine) setEngine(nextEngine);
        setProviderId(str(payload.provider) || null);
      };
      const offs = [
        ctx.events.on("session://activated", apply),
        ctx.events.on("session://selection-changed", apply),
      ];
      return () => {
        for (const off of offs) {
          try {
            off();
          } catch {
            /* 已卸载 */
          }
        }
      };
    }, []);

    const section = useMemo(() => {
      const found = engine
        ? hubState.sections.find((item) => item.engine === engine && item.channels.length > 0)
        : null;
      return found ?? hubState.sections.find((item) => item.channels.length > 0) ?? null;
    }, [hubState.sections, engine]);

    const channel = useMemo(() => {
      if (!section) return null;
      const wanted = section.engine === engine ? providerId : null;
      return (
        section.channels.find((item) => wanted && item.id === wanted) ??
        section.channels.find((item) => item.current) ??
        section.channels[0] ??
        null
      );
    }, [section, providerId, engine]);

    const key = section && channel ? `${section.engine}:${channel.id}` : null;
    const result = key ? hubState.results[key] : null;
    targetRef.current = key && channel ? { key, channel } : null;

    // 首次定位到当前渠道（或切换会话后）先查一次；之后的节奏交给定时器。
    useEffect(() => {
      const target = targetRef.current;
      if (!target || hub.snapshot().results[target.key]) return;
      void hub.query(target.key, target.channel);
    }, [key]);

    useEffect(() => {
      const timer = setInterval(() => {
        setNow(Date.now());
        const target = targetRef.current;
        if (!target) return;
        const entry = hub.snapshot().results[target.key];
        if (!entry || entry.refreshing || entry.state === "loading") return;
        const age = Date.now() - (entry.at ?? 0);
        if (entry.state === "ok" && age >= POLL_MS) {
          void hub.query(target.key, target.channel);
        } else if (entry.state === "error" && age >= 5 * 60 * 1000) {
          // 失败的渠道降频重试，别每 15 秒去打一次坏 Key。
          void hub.query(target.key, target.channel);
        }
      }, TICK_MS);
      return () => clearInterval(timer);
    }, []);

    const tone = toneOf(result);
    const focus = focusWindow(result);
    const remain = focus ? clamp(100 - focus.usedPercent, 0, 100) : null;
    const after = focus?.resetAt ? compactAfter(focus.resetAt, now) : "";
    // 芯片上的数字就是「最小窗口」，圆点跟着这个数字走，免得数字绿、圆点红。
    const valueColor =
      remain == null ? tone.color : remain <= 10 ? COLORS.danger : remain <= 30 ? COLORS.warn : COLORS.ok;
    const valueText =
      result == null
        ? channel
          ? "…"
          : "点此导入"
        : result.state === "loading"
          ? "…"
          : result.state !== "ok"
            ? tone.label
            : result.kind === "windows"
              ? `${Math.round(remain ?? 0)}%`
              : money(result.amount, result.currency);

    const title = (() => {
      const head = section && channel ? `${engineLabel(section.engine)} · ${channel.name}` : "渠道余量";
      if (!result) return `${head}\n点一下打开面板`;
      if (result.state === "ok" && result.kind === "windows") {
        const lines = result.windows.map(
          (item) =>
            `${item.label}：剩 ${Math.round(clamp(100 - item.usedPercent, 0, 100))}%` +
            (item.resetAt ? `，${afterLabel(item.resetAt, now)}` : ""),
        );
        return [head, ...lines, "点一下打开面板"].join("\n");
      }
      if (result.state === "ok" && result.kind === "balance") {
        return [head, `余额 ${money(result.amount, result.currency)}`, "点一下打开面板"].join("\n");
      }
      return [head, result.title ?? "", "点一下打开面板"].filter(Boolean).join("\n");
    })();

    // 刷新过程中只在悬浮提示里说明，芯片本身不动，免得闪。
    const titleText = result?.refreshing ? `${title}\n（正在更新…）` : title;

    // 点一下：先挂一个「待刷新」，再打开页签（面板看到就会整体刷一遍）。
    const openPanel = () => {
      hub.requestRefresh(section?.engine ?? engine);
      ctx.ui.openCenterTab(CENTER_TAB_KEY);
    };

    return h(
      "button",
      {
        type: "button",
        style: S.chipBtn,
        title: titleText,
        "aria-label": `渠道余量 ${valueText}`,
        onClick: openPanel,
      },
      h("span", { style: { ...S.chipDot, background: remain == null ? tone.color : valueColor } }),
      h("span", { style: { ...S.chipValue, color: valueColor } }, valueText),
      after ? h("span", { style: S.chipAfter }, after) : null,
    );
  }

  ctx.ui.registerCenterTab({
    key: CENTER_TAB_KEY,
    title: () => "渠道余量",
    icon: Icon,
    component: Board,
  });

  ctx.ui.registerStatusBarItem({
    key: "chip",
    zone: "start",
    order: 40,
    component: Chip,
  });
}

function messageOf(error) {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? "");
  return text || "未知错误";
}
