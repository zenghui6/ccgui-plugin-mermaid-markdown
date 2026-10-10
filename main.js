/**
 * Mermaid 图表 —— CC GUI 插件
 * ---------------------------------------------------------------------------
 * 作用：把聊天回答里 ```mermaid / ```mmd 围栏代码块渲染成真正的图表。
 *
 * 为什么走「rehype 改写 + 覆盖 div」而不是覆盖 pre/code：
 * 1. 宿主 markdown 管线（react-markdown）按「宿主组件在前、插件组件在后」合并
 *    `components`，覆盖 pre/code 会连带丢掉宿主的代码块卡片、复制按钮与文件
 *    链接能力；宿主自己没有覆盖 div，占用 div 的代价最小。
 * 2. rehype 插件在宿主默认插件之后、reveal（流式逐字显示）之前运行，把
 *    <pre><code class="language-mermaid"> 就地换成带标记 class 的 <div>。文本
 *    内容原地保留（reveal 的字符偏移依赖文档文本顺序，不能额外复制一份源码
 *    到属性里，否则偏移会错位）。此时流式管道看它是一个普通 div，只有我们
 *    的 div 组件认识这个标记。
 * 3. 只改写「围栏已闭合」的代码块：模型流式输出时半截的 mermaid 块继续按
 *    普通代码块显示，闭合那一刻宿主重跑管线才渲染成图，避免对半截语法反复
 *    尝试渲染。
 *
 * mermaid 本体约 3.5MB，按市场「main.js ≤ 2MB」的约束不能内联进代码，因此
 * 作为插件目录内的随包资源（mermaid.min.js），经 ctx.assets.bundleUrl 懒加载
 * （宿主 CSP 的 script-src 已放行 pluginasset: 源），首次遇到图表时才注入
 * <script>，之后复用 globalThis.mermaid 单例。
 */

/** 标记 class：rehype 插件写入、div 组件识别；命名带插件前缀避免与宿主类名相撞。 */
const MARKER_CLASS = "ccgui-mermaid-block";
/** 随包资源文件名（与 main.js 同目录）。 */
const MERMAID_ASSET = "mermaid.min.js";
/** 支持的围栏语言标记（与宿主语言高亮同款 `language-*` class 形态）。 */
const LANGUAGE_PATTERN = /^language-(mermaid|mmd)$/i;

/** 图表显示大小：统一等比缩放已渲染的 SVG（字号、线宽、箭头一起缩）。
 *  默认「原尺寸」——即不做缩放，保持 mermaid 出图的本来大小。 */
const CHART_SCALES = [
  { key: "small", scale: 0.7 },
  { key: "medium", scale: 0.85 },
  { key: "full", scale: 1 },
];
/** 为塞进容器宽度而缩小的下限：再宽就保持这个比例并横向滚动。
 *  无限等比缩小会把字缩成蚂蚁（宽图 = 负向反馈）；0.75 时默认密度下 16px
 *  标签仍有 12px 实感（约等于正文），而只差几个百分点就能放下的图仍会
 *  自动适配、不会为了 3% 溢出就长出滚动条。更宽才滚动取全，
 *  这也是 GitHub / Obsidian 的 mermaid 预览思路（不缩放、容器滚动）。 */
const MIN_FIT_RATIO = 0.75;
/** 布局密度：决定 mermaid 自身的字号与节点间距，改密度需要重新出图。 */
const CHART_DENSITIES = {
  standard: { key: "standard", config: {} },
  compact: {
    key: "compact",
    config: {
      fontSize: 13,
      themeVariables: { fontSize: "13px" },
      flowchart: { nodeSpacing: 22, rankSpacing: 24, padding: 5, diagramPadding: 3 },
      sequence: { diagramMarginX: 20, diagramMarginY: 6, actorMargin: 30, width: 110, boxMargin: 6, boxTextMargin: 3, noteMargin: 6, messageMargin: 22, bottomMarginAdj: 1 },
    },
  },
};
const SCALE_STORAGE_KEY = "chartScale";
const DENSITY_STORAGE_KEY = "chartDensity";
const DEFAULT_SCALE_KEY = "full";
const DEFAULT_DENSITY_KEY = "standard";

/** 文案资源：插件 UI 文本一律走这份表，并按 ctx.i18n 注册进宿主（审核规范 §6.4/§11.2）。 */
const I18N_NAMESPACE = "mermaid-markdown";
const MESSAGES = {
  "zh-CN": {
    sectionLabel: "图表大小",
    sizeTitle: "显示大小",
    densityTitle: "布局密度",
    sizeNames: { small: "小", medium: "中", full: "原尺寸" },
    densityNames: { standard: "标准", compact: "紧凑" },
    sizeHints: {
      small: "整图等比缩到 70%",
      medium: "整图等比缩到 85%",
      full: "不缩放，保持出图原始大小",
    },
    densityHints: {
      standard: "mermaid 默认 16px 字号与默认间距",
      compact: "13px 字号 + 紧凑间距，长流程图明显省高度",
    },
    optionLabel: (name, scale) => `${name}（×${scale}）`,
    current: (size, scale, density) => `当前：${size} ×${scale} · 密度 ${density}`,
    footer: "缩放是等比几何缩放（字号、线宽、箭头一起缩），只影响显示；密度决定 mermaid 出图时的字号与节点间距，改动会重新出图。",
    zoomHint: "点击放大",
    zoomTitle: "放大查看",
    zoomClose: "关闭",
    zoomTip: "点击聊天里的图表可放大查看（Esc 或点空白关闭）。",
    failureDetail: (error) => `Mermaid 渲染失败（${error}），以下为源码`,
  },
  en: {
    sectionLabel: "Chart size",
    sizeTitle: "Display size",
    densityTitle: "Layout density",
    sizeNames: { small: "Small", medium: "Medium", full: "Full size" },
    densityNames: { standard: "Standard", compact: "Compact" },
    sizeHints: {
      small: "Scale the whole diagram to 70%",
      medium: "Scale the whole diagram to 85%",
      full: "No scaling — the diagram's natural size",
    },
    densityHints: {
      standard: "mermaid defaults: 16px labels, default spacing",
      compact: "13px labels + tight spacing; much shorter long flowcharts",
    },
    optionLabel: (name, scale) => `${name} (×${scale})`,
    current: (size, scale, density) => `Current: ${size} ×${scale} · density ${density}`,
    footer: "Scaling shrinks the rendered SVG uniformly (labels, strokes, arrows) and only affects display; density sets the font size and node spacing mermaid renders with, which re-renders the diagram.",
    zoomHint: "Click to enlarge",
    zoomTitle: "Enlarged view",
    zoomClose: "Close",
    zoomTip: "Click a diagram in the chat to view it enlarged (Esc or click outside to close).",
    failureDetail: (error) => `Mermaid render failed (${error}) — showing the source`,
  },
};

/** 图表挂载点标记：清理 mermaid 残留节点时用来排除「我们自己已挂载的图」。 */
const HOST_ATTR = "data-ccgui-mermaid-host";

/** 图表容器：横向可滚动，用来承载宽图（见 MIN_FIT_RATIO）。
 *  `justify-content: center` 在内容溢出时会把左侧推出可滚动范围（经典 flex
 *  溢出坑），所以改成 flex-start + SVG 自身 `margin-inline: auto`：
 *  装得下时自动居中，装不下时左对齐且能滚到最左。 */
const WRAP_STYLE = {
  display: "flex",
  justifyContent: "flex-start",
  alignItems: "center",
  maxWidth: "100%",
  margin: "8px 0",
  overflowX: "auto",
  overflowY: "hidden",
};

const SOURCE_PRE_STYLE = {
  flex: "1 1 auto",
  margin: 0,
  padding: "10px 12px",
  overflowX: "auto",
  border: "1px solid var(--color-border-button-default, rgba(127, 127, 127, 0.28))",
  borderRadius: 8,
  background: "var(--color-background-secondary-default, transparent)",
  color: "var(--color-text-primary, inherit)",
  fontSize: 12.5,
  lineHeight: 1.5,
};

const FAILURE_NOTE_STYLE = {
  flex: "0 0 auto",
  alignSelf: "flex-start",
  padding: "0 0 4px 2px",
  fontSize: 12,
  color: "var(--color-text-secondary, inherit)",
};

const SCALE_BUTTON_STYLE = {
  padding: "6px 12px",
  border: "1px solid var(--color-border-button-default, rgba(127, 127, 127, 0.35))",
  borderRadius: 6,
  background: "transparent",
  color: "var(--color-text-primary, inherit)",
  fontSize: 13,
  cursor: "pointer",
};

const SCALE_BUTTON_ACTIVE_STYLE = {
  borderColor: "var(--color-accent-500, currentcolor)",
  background: "var(--color-background-primary-hover, rgba(127, 127, 127, 0.18))",
  fontWeight: 600,
};

const SCALE_HINT_STYLE = {
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--color-text-secondary, inherit)",
};

/* 点击放大：视口级浮层。宿主给 overlay 容器设的是 pointer-events: none，
 * 所以遮罩必须显式开回 auto，否则点不到。 */
const ZOOM_BACKDROP_STYLE = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  background: "rgba(0, 0, 0, 0.55)",
  pointerEvents: "auto",
};

const ZOOM_PANEL_STYLE = {
  display: "flex",
  flexDirection: "column",
  maxWidth: "min(1600px, 96vw)",
  maxHeight: "92vh",
  border: "1px solid var(--color-border-button-default, rgba(127, 127, 127, 0.35))",
  borderRadius: 10,
  background: "var(--color-background-primary-default, #fff)",
  boxShadow: "0 24px 64px rgba(0, 0, 0, 0.35)",
  overflow: "hidden",
};

const ZOOM_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 12px",
  borderBottom: "1px solid var(--color-border-button-default, rgba(127, 127, 127, 0.28))",
};

const ZOOM_TITLE_STYLE = {
  flex: "1 1 auto",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--color-text-primary, inherit)",
};

const ZOOM_CLOSE_STYLE = {
  flex: "0 0 auto",
  padding: "4px 10px",
  border: "1px solid var(--color-border-button-default, rgba(127, 127, 127, 0.35))",
  borderRadius: 6,
  background: "transparent",
  color: "var(--color-text-primary, inherit)",
  fontSize: 12,
  cursor: "pointer",
};

/** 放大视图内容区：横向/纵向都可滚动，图按原始尺寸显示（不缩小）。
 *  必须用块级布局：flex 容器里子项默认 `flex-shrink: 1`，会把显式的
 *  原始宽度压回容器宽度（实测 1895px 被压成 926px），块级才会溢出滚动。 */
const ZOOM_BODY_STYLE = {
  display: "block",
  padding: 12,
  overflow: "auto",
};

/* ------------------------------------------------------------------ *
 * rehype 改写（纯函数，不依赖 React / ctx）
 * ------------------------------------------------------------------ */

/** 失败提示里显示的错误摘要：单行、限长，完整信息保留在 title 上。 */
function shortError(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** 递归取节点下所有文本（高亮插件可能已把代码切成 span 子树）。 */
function collectText(node) {
  if (!node) return "";
  if (node.type === "text") return typeof node.value === "string" ? node.value : "";
  if (Array.isArray(node.children)) return node.children.map(collectText).join("");
  return "";
}

function isMermaidCodeElement(node) {
  if (node?.type !== "element" || node.tagName !== "code") return false;
  const classes = node.properties?.className;
  return Array.isArray(classes) && classes.some((name) => typeof name === "string" && LANGUAGE_PATTERN.test(name));
}

/**
 * 围栏是否已闭合（与宿主 cached-highlight 判定一致）：MDX/markdown 解析出的
 * code 节点 position 覆盖整段围栏（含起止 ```），用原始文本切片比对首尾围栏。
 * 拿不到原始文本或 position 时按「已闭合」处理——那说明这不是流式快照，
 * 渲染图表才是用户预期。
 */
function isFenceClosed(element, source) {
  const start = element.position?.start?.offset;
  const end = element.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || !source) return true;
  const raw = source.slice(start, end);
  const opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n/.exec(raw);
  if (!opening) return true;
  const lastLine = raw.slice(raw.lastIndexOf("\n") + 1).replace(/\r$/, "");
  const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lastLine);
  return !!closing && closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length;
}

/** 就地遍历 hast：把已闭合的 mermaid 代码块换成带标记的 div。 */
function rewriteMermaidBlocks(parent, source) {
  if (!Array.isArray(parent.children)) return;
  for (let index = 0; index < parent.children.length; index += 1) {
    const node = parent.children[index];
    if (node?.type !== "element") continue;
    if (node.tagName === "pre") {
      const code = (node.children ?? []).find(isMermaidCodeElement);
      if (code && isFenceClosed(code, source)) {
        parent.children[index] = {
          type: "element",
          tagName: "div",
          properties: { className: [MARKER_CLASS] },
          children: [{ type: "text", value: collectText(code) }],
          position: node.position,
        };
        continue;
      }
    }
    rewriteMermaidBlocks(node, source);
  }
}

/** unified 插件：`file` 是 VFile，`file.value` 为本次渲染的 markdown 原文。 */
function rehypeMermaidBlocks() {
  return (tree, file) => {
    const source = typeof file?.value === "string" ? file.value : "";
    rewriteMermaidBlocks(tree, source);
  };
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useRef } = ctx.react;
  const logPrefix = `[${ctx.pluginId}]`;

  /** 宿主 i18next 的语言码是 zh / en；zh 变体统一落到 zh-CN 文案。 */
  function resolveLocale() {
    const locale = String(ctx.host?.locale ?? "zh").toLowerCase();
    return locale.startsWith("zh") ? "zh-CN" : "en";
  }
  const currentMessages = () => MESSAGES[resolveLocale()];
  // 注册进宿主的 i18next（审核规范 §6.4）：zh-CN / zh 指向同一份文案，en 单独一份。
  ctx.i18n.addBundle("zh-CN", I18N_NAMESPACE, MESSAGES["zh-CN"]);
  ctx.i18n.addBundle("zh", I18N_NAMESPACE, MESSAGES["zh-CN"]);
  ctx.i18n.addBundle("en", I18N_NAMESPACE, MESSAGES.en);

  /** mermaid 懒加载状态：promise 复用保证只注入一次 <script>。 */
  const mermaidState = { promise: null, mermaid: null, configuredTheme: null };
  /** 渲染 id：加每次激活的随机标签 + 全局递增序号。
   *  只看自增序号会在「热重载后同页存在上一实例的图」时与旧 id 碰撞，
   *  而失败兜底清理按 id 查 DOM，会把旧实例已挂载的图误删。 */
  const activationTag = Math.random().toString(36).slice(2, 8);
  let renderSeq = 0;

  /** 清理 mermaid 可能残留的临时节点；只删不在我们挂载点内的节点，
   *  避免 id 复用（历史实例/其它插件）时误删正常渲染结果。 */
  function cleanupRenderNodes(id) {
    for (const candidate of [`d${id}`, id]) {
      const node = document.getElementById(candidate);
      if (node && !node.closest(`[${HOST_ATTR}]`)) node.remove();
    }
  }
  /** 渲染串行队列：mermaid 的 initialize 是全局配置，交错会串主题。 */
  let renderQueue = Promise.resolve();

  /** 主题订阅：宿主切换深/浅色只改 <html> 的 class，图表需要跟着重渲染。 */
  const themeListeners = new Set();
  let themeObserver = null;
  let themeVersion = 0;

  function currentTheme() {
    if (document.documentElement.classList.contains("dark")) return "dark";
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
    if (match) {
      const luminance = 0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3]);
      return luminance < 128 ? "dark" : "default";
    }
    return "default";
  }

  function ensureThemeObserver() {
    if (themeObserver) return;
    themeObserver = new MutationObserver(() => {
      themeVersion += 1;
      for (const listener of themeListeners) listener(themeVersion);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  }

  function useThemeVersion() {
    const [version, setVersion] = useState(themeVersion);
    useEffect(() => {
      ensureThemeObserver();
      const listener = (next) => setVersion(next);
      themeListeners.add(listener);
      return () => {
        themeListeners.delete(listener);
      };
    }, []);
    return version;
  }

  /** 偏好在设置页写入、所有已挂载图表即时跟随。 */
  function createPreference(storageKey, defaultKey, isKnownKey) {
    const state = { key: defaultKey, listeners: new Set() };
    const set = (key) => {
      if (!isKnownKey(key) || state.key === key) return;
      state.key = key;
      for (const listener of state.listeners) listener(key);
    };
    const useValue = () => {
      const [key, setKey] = useState(state.key);
      useEffect(() => {
        const listener = (next) => setKey(next);
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      }, []);
      return key;
    };
    const load = () =>
      ctx.storage
        .get(storageKey)
        .then((stored) => {
          if (typeof stored === "string" && isKnownKey(stored)) {
            set(stored);
          } else if (stored !== null && stored !== undefined) {
            console.warn(`${logPrefix} 忽略 ${storageKey} 的未知取值：${String(stored)}`);
          }
        })
        .catch((error) => {
          console.warn(`${logPrefix} 读取 ${storageKey} 失败：${error?.message ?? error}`);
        });
    const save = (key) => {
      console.info(`${logPrefix} ${storageKey} 切换为 ${key}`);
      ctx.storage.set(storageKey, key).catch((error) => {
        console.warn(`${logPrefix} 保存 ${storageKey} 失败：${error?.message ?? error}`);
      });
    };
    return { get: () => state.key, set, useValue, load, save, dispose: () => state.listeners.clear() };
  }

  const scaleSetting = createPreference(SCALE_STORAGE_KEY, DEFAULT_SCALE_KEY, (key) =>
    CHART_SCALES.some((entry) => entry.key === key));
  const densitySetting = createPreference(DENSITY_STORAGE_KEY, DEFAULT_DENSITY_KEY, (key) =>
    Object.prototype.hasOwnProperty.call(CHART_DENSITIES, key));

  function loadMermaid() {
    if (mermaidState.mermaid) return Promise.resolve(mermaidState.mermaid);
    if (mermaidState.promise) return mermaidState.promise;
    mermaidState.promise = new Promise((resolve, reject) => {
      const existing = globalThis.mermaid;
      if (existing) {
        resolve(existing);
        return;
      }
      let url;
      try {
        url = ctx.assets.bundleUrl(MERMAID_ASSET);
      } catch (error) {
        reject(error);
        return;
      }
      // 注入的是**插件自身包内**资源（host 的 pluginasset 源，路径由 ctx.assets
      // 生成），不是远程脚本：规范 §6.5 允许执行包内 JS，禁止的是远程/目录授权
      // 来源。这里不联网、不接受任何外部 URL。
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = () => {
        const loaded = globalThis.mermaid;
        if (loaded) {
          resolve(loaded);
        } else {
          reject(new Error(`脚本已加载但未挂载 globalThis.mermaid：${url}`));
        }
      };
      script.onerror = () => reject(new Error(`随包资源加载失败：${url}`));
      document.head.append(script);
    })
      .then((mermaid) => {
        mermaidState.mermaid = mermaid;
        console.info(`${logPrefix} mermaid ${mermaid?.version ?? "unknown"} 已就绪`);
        return mermaid;
      })
      .catch((error) => {
        mermaidState.promise = null; // 允许后续重试（例如宿主尚未就绪）
        throw error;
      });
    return mermaidState.promise;
  }

  function enqueueRender(task) {
    const result = renderQueue.then(task, task);
    renderQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function renderDiagram(code, theme, densityKey) {
    const mermaid = await loadMermaid();
    const density = CHART_DENSITIES[densityKey] ?? CHART_DENSITIES[DEFAULT_DENSITY_KEY];
    const configKey = `${theme}|${density.key}`;
    if (mermaidState.configuredTheme !== configKey) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme,
        fontFamily: getComputedStyle(document.body).fontFamily || "inherit",
        // 标准密度 = mermaid 原样（16px + 默认间距）；紧凑密度由 CHART_DENSITIES
        // 覆盖字号与间距。注意 themeVariables.fontSize 才决定 flowchart 标签字号，
        // 顶层 fontSize 对它无效（但驱动 sequence 等图）。
        ...density.config,
      });
      mermaidState.configuredTheme = configKey;
    }
    const id = `ccgui-mermaid-${activationTag}-${++renderSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      return svg;
    } finally {
      // 解析失败时 mermaid 可能留下临时节点（不同版本前缀不一致），兜底清理。
      cleanupRenderNodes(id);
    }
  }

  /** 放大查看状态：聊天里的图表点击后交给 overlay 按原始尺寸显示。
   *  聊天里的图和浮层是两个挂载点，用这份 activate 级状态互通。 */
  const viewer = { svg: null, listeners: new Set() };

  function publishViewer(svg) {
    viewer.svg = svg;
    for (const listener of viewer.listeners) listener(svg);
  }

  function useViewer() {
    const [svg, setSvg] = useState(viewer.svg);
    useEffect(() => {
      const listener = (next) => setSvg(next);
      viewer.listeners.add(listener);
      return () => {
        viewer.listeners.delete(listener);
      };
    }, []);
    return svg;
  }

  /** 放大浮层：点遮罩、点关闭、按 Esc 都关闭；图按原始宽度渲染，容器滚动。 */
  function ZoomOverlay() {
    const svg = useViewer();
    const bodyRef = useRef(null);

    useEffect(() => {
      if (!svg) return undefined;
      const body = bodyRef.current;
      if (body) mountSvg(body, svg, 1, { fitFloor: 0 });
      const onKeyDown = (event) => {
        if (event.key === "Escape") publishViewer(null);
      };
      document.addEventListener("keydown", onKeyDown);
      return () => document.removeEventListener("keydown", onKeyDown);
    }, [svg]);

    if (!svg) return null;
    const m = currentMessages();
    return h(
      "div",
      {
        style: ZOOM_BACKDROP_STYLE,
        role: "dialog",
        "aria-modal": "true",
        "aria-label": m.zoomTitle,
        onClick: () => publishViewer(null),
      },
      h(
        "div",
        { style: ZOOM_PANEL_STYLE, onClick: (event) => event.stopPropagation() },
        h(
          "div",
          { style: ZOOM_HEADER_STYLE },
          h("div", { style: ZOOM_TITLE_STYLE }, m.zoomTitle),
          h(
            "button",
            { type: "button", style: ZOOM_CLOSE_STYLE, onClick: () => publishViewer(null) },
            m.zoomClose,
          ),
        ),
        // 关掉时清空挂载点由 React 卸载子树完成；容器只负责滚动。
        h("div", { ref: bodyRef, style: ZOOM_BODY_STYLE }),
      ),
    );
  }

  /** 把 mermaid 产出的 SVG 字符串挂到容器上：按 text/html 解析后取 <svg> 节点再
   *  import，与浏览器内联 SVG 的方式一致。**不能用 `image/svg+xml`**：标签里的
   *  `<br/>` 会被 mermaid 序列化成 HTML 空标签 `<br>`（未自闭合），严格 XML 解析
   *  直接报 "Opening and ending tag mismatch"，整张图降级成"渲染失败"（实测）。
   *  解析失败时不抛异常，返回 false 交给组件显示源码。
   *  scale < 1 时按 viewBox 宽高重设 svg 尺寸——几何等比缩小（字号、线宽、
   *  箭头一起缩），比继续压字号更接近「整张图小一圈」且不会重排标签。 */
  function mountSvg(host, svg, scale, options = {}) {
    const parsed = new DOMParser().parseFromString(svg, "text/html");
    const root = parsed.querySelector("svg");
    if (!root) return false;
    const viewBox = (root.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    const naturalWidth = viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : null;
    // fitFloor=0（放大视图）表示完全不缩小：按原始宽度放，超出由容器滚动。
    const fitFloor = options.fitFloor ?? MIN_FIT_RATIO;
    if (naturalWidth) {
      const targetWidth = Math.round(naturalWidth * scale);
      root.style.width = `${targetWidth}px`;
      // 只允许为适配容器缩小到 fitFloor：min-width 会在容器更窄时压过
      // max-width（CSS 规则），于是图形保持可读字号、由容器横向滚动。
      root.style.minWidth = `${Math.round(targetWidth * fitFloor)}px`;
      root.style.maxWidth = fitFloor > 0 ? "100%" : "none";
      root.style.height = "auto";
      root.style.display = "block";
      root.style.marginInline = "auto";
    }
    host.replaceChildren(document.importNode(root, true));
    return true;
  }

  function plainText(node) {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(plainText).join("");
    if (ctx.react.isValidElement(node)) return plainText(node.props?.children);
    return "";
  }

  /** 图表块：源码先按代码块显示，渲染成功后整体换成 SVG。 */
  function MermaidBlock({ children }) {
    const code = plainText(children);
    const version = useThemeVersion();
    const scaleKey = scaleSetting.useValue();
    const densityKey = densitySetting.useValue();
    const hostRef = useRef(null);
    const [svg, setSvg] = useState(null);
    const [failure, setFailure] = useState(null);

    useEffect(() => {
      let cancelled = false;
      setSvg(null);
      setFailure(null);
      if (!code.trim()) return undefined;
      const theme = currentTheme();
      enqueueRender(() => renderDiagram(code, theme, densityKey)).then(
        (next) => {
          if (!cancelled) setSvg(next);
        },
        (error) => {
          if (cancelled) return;
          setFailure(error?.message ?? String(error));
          console.warn(`${logPrefix} mermaid 渲染失败：${error?.message ?? error}`);
        },
      );
      return () => {
        cancelled = true;
      };
    }, [code, version, densityKey]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      if (!svg) {
        host.replaceChildren();
        return;
      }
      const scale = CHART_SCALES.find((entry) => entry.key === scaleKey)?.scale ?? 1;
      if (!mountSvg(host, svg, scale)) {
        setSvg(null);
        setFailure("mermaid 输出不是合法 SVG");
      }
    }, [svg, scaleKey]);

    const openViewer = () => {
      if (svg) publishViewer(svg);
    };

    return h(
      "div",
      { style: WRAP_STYLE },
      h("div", {
        ref: hostRef,
        [HOST_ATTR]: "1",
        style: svg ? { display: "contents" } : { display: "none" },
        // 渲染成功才可点：点击/回车把当前 SVG 交给浮层放大（浮层按原始尺寸显示）
        ...(svg
          ? {
              role: "button",
              tabIndex: 0,
              title: currentMessages().zoomHint,
              onClick: openViewer,
              onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openViewer();
                }
              },
              style: { display: "contents", cursor: "zoom-in" },
            }
          : null),
      }),
      svg
        ? null
        : h(
            "div",
            { style: { display: "flex", flexDirection: "column", minWidth: 0, maxWidth: "100%" } },
            failure
              ? h("div", { style: FAILURE_NOTE_STYLE, title: failure }, currentMessages().failureDetail(shortError(failure)))
              : null,
            h("pre", { style: SOURCE_PRE_STYLE }, h("code", null, code)),
          ),
    );
  }

  /** markdown 里所有 div 都会经过这里；只有带标记的才交给图表组件。 */
  function MarkdownDiv({ node, children, ...rest }) {
    void node;
    const classes = Array.isArray(rest.className) ? rest.className : [rest.className];
    if (!classes.some((name) => name === MARKER_CLASS)) return h("div", rest, children);
    return h(MermaidBlock, null, children);
  }

  /** 单个档位行：标题 + 按钮组 + 当前档位说明。 */
  function SettingRow({ title, options, activeKey, hintOf, format, onSelect }) {
    const activeHint = hintOf(activeKey);
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 8 } },
      h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--color-text-primary, inherit)" } }, title),
      h(
        "div",
        { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        options.map((option) =>
          h(
            "button",
            {
              key: option.key,
              type: "button",
              "aria-pressed": option.key === activeKey ? "true" : "false",
              title: hintOf(option.key),
              onClick: () => onSelect(option.key),
              style: {
                ...SCALE_BUTTON_STYLE,
                ...(option.key === activeKey ? SCALE_BUTTON_ACTIVE_STYLE : null),
              },
            },
            format(option),
          ),
        ),
      ),
      h("div", { style: SCALE_HINT_STYLE }, activeHint),
    );
  }

  /** 设置页：图表大小 + 布局密度（写入插件存储，改完所有图表即时跟随）。 */
  function SettingsPanel() {
    const scaleKey = scaleSetting.useValue();
    const densityKey = densitySetting.useValue();
    const m = currentMessages();
    const scaleOf = (key) => CHART_SCALES.find((entry) => entry.key === key)?.scale ?? 1;
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 16, padding: "4px 0", maxWidth: 560 } },
      h(SettingRow, {
        title: m.sizeTitle,
        options: CHART_SCALES,
        activeKey: scaleKey,
        hintOf: (key) => m.sizeHints[key],
        format: (option) => m.optionLabel(m.sizeNames[option.key], option.scale),
        onSelect: (key) => {
          scaleSetting.set(key);
          scaleSetting.save(key);
        },
      }),
      h(SettingRow, {
        title: m.densityTitle,
        options: Object.values(CHART_DENSITIES),
        activeKey: densityKey,
        hintOf: (key) => m.densityHints[key],
        format: (option) => m.densityNames[option.key],
        onSelect: (key) => {
          densitySetting.set(key);
          densitySetting.save(key);
        },
      }),
      h("div", { style: SCALE_HINT_STYLE }, m.footer),
      h("div", { style: SCALE_HINT_STYLE }, m.zoomTip),
      h("div", { style: SCALE_HINT_STYLE }, m.current(m.sizeNames[scaleKey], scaleOf(scaleKey), m.densityNames[densityKey])),
    );
  }

  ctx.ui.registerMarkdownRenderer({
    key: "mermaid",
    rehypePlugins: [rehypeMermaidBlocks],
    components: { div: MarkdownDiv },
  });
  ctx.ui.registerSettingsSection({
    key: "size",
    label: () => currentMessages().sectionLabel,
    component: SettingsPanel,
  });
  // 点击放大用的视口级浮层（ui:overlay）：平时渲染 null，只在点开图表时出现。
  ctx.ui.registerOverlay({ key: "zoom", component: ZoomOverlay, order: 0 });
  console.info(`${logPrefix} 已注册 Markdown mermaid 渲染扩展`);

  void scaleSetting.load();
  void densitySetting.load();

  return () => {
    themeObserver?.disconnect();
    themeObserver = null;
    themeListeners.clear();
    scaleSetting.dispose();
    densitySetting.dispose();
    viewer.listeners.clear();
    console.info(`${logPrefix} 已卸载`);
  };
}
