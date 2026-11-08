/**
 * dsh-grid-ui · host/tools.js
 * 向模型注册工具：
 *   create_ui_window / update_ui_window / remove_ui_window   （窗口 / 按钮 / 面板）
 *   create_ui_page  / delete_ui_page                          （画布页）
 *   open_ui_panel   / close_ui_panel                          （全屏面板）
 *
 * 注册方式：ctx.tools.register(definition)，definition 形态与
 * @deepseek-ai/dsh-tools 的 defineTool 输出一致（name / description / parameters /
 * output / execute）。这里直接写定义对象，避免依赖 dsh-tools 的内部 API 版本差异。
 */

import { GRID_SIZE, MAX_PAGES, MAX_WINDOWS_PER_PAGE, assertRect, GridUiError } from './windows.js';
import { sanitizeHtml } from './sanitize.js';

/** 网格坐标的 JSON Schema 片段（保持极简，范围在 execute 里校验以给出中文报错） */
function coordSchema(label, meaning) {
  return {
    type: 'number',
    description: `${label}：${meaning}，取值 0-${GRID_SIZE}（0 为左/上边缘，${GRID_SIZE} 为右/下边缘）`
  };
}

/** 画布页参数（对模型用 1 基，对注册表用 0 基） */
const PAGE_SCHEMA = {
  type: 'number',
  description: `可选，窗口放在第几页（1 开始，默认 1）。用 create_ui_page 新建更多页，例如做多页 PPT`
};

const KIND_SCHEMA = {
  type: 'string',
  enum: ['window', 'button', 'panel'],
  description:
    '可选，窗口类型，默认 window。' +
    'window = 普通浮动窗口（网格矩形内渲染 HTML）；' +
    'button = 浮动按钮（显示 text，点击后在整屏弹出它的面板页）；' +
    'panel = 全屏面板页（平时不显示，只能被 button / open_ui_panel / dsh.openPanel(id) 打开，打开时铺满 DSH 窗口并带关闭按钮）'
};

const PARAMETERS_CREATE = {
  type: 'object',
  properties: {
    gridX1: coordSchema('gridX1', '矩形左上角的 X 格点'),
    gridY1: coordSchema('gridY1', '矩形左上角的 Y 格点'),
    gridX2: coordSchema('gridX2', '矩形右下角的 X 格点'),
    gridY2: coordSchema('gridY2', '矩形右下角的 Y 格点'),
    windowId: {
      type: 'string',
      description: '窗口唯一 ID（字母/数字/下划线/点/冒号/中划线，≤64 字符），后续更新或删除时使用'
    },
    kind: KIND_SCHEMA,
    page: PAGE_SCHEMA,
    title: {
      type: 'string',
      description: '可选的窗口标题，仅用于标识，不显示在窗口内'
    },
    text: {
      type: 'string',
      description: 'kind=button 时按钮上显示的文字（也用作面板标题的默认值）'
    },
    targetId: {
      type: 'string',
      description:
        '可选，仅 kind=button 有意义：点击后打开哪个 panel 窗口。' +
        '省略时按钮自己的 html 就是弹出页的内容'
    },
    html: {
      type: 'string',
      description:
        '窗口或面板内的完整 HTML：可以是完整文档（含 html/head/body），也可以只写 body 内部内容，插件会自动包装成完整文档。' +
        'kind=button 时为点击后弹出页的内容，可省略（只做按钮）。' +
        '页面可通过 window.dsh 调用 DSH，详见 window.dsh 文档'
    },
    url: {
      type: 'string',
      description:
        '可选：直接嵌入一个远程网页（只支持 http/https）。给了 url 时窗口就是一个「浏览器」窗口，' +
        '用 iframe 加载该地址，html 不再参与渲染；不提供时按 html 渲染。' +
        '注意：对方站点如果设置了 X-Frame-Options / CSP frame-ancestors，浏览器会拒绝内嵌（这属于站点限制，插件无法绕过）。'
    }
  },
  required: ['gridX1', 'gridY1', 'gridX2', 'gridY2', 'windowId']
};

const PARAMETERS_UPDATE = {
  type: 'object',
  properties: {
    windowId: { type: 'string', description: '要更新的窗口 ID' },
    html: { type: 'string', description: '可选，新的完整 HTML 内容' },
    url: {
      type: 'string',
      description:
        '可选：把窗口改成网址窗口（http/https）。传空字符串表示改回普通 HTML 窗口。'
    },
    kind: KIND_SCHEMA,
    text: { type: 'string', description: '可选，按钮文字' },
    targetId: { type: 'string', description: '可选，按钮点击后打开的面板 ID' },
    page: PAGE_SCHEMA,
    gridX1: coordSchema('gridX1', '新的左上角 X 格点'),
    gridY1: coordSchema('gridY1', '新的左上角 Y 格点'),
    gridX2: coordSchema('gridX2', '新的右下角 X 格点'),
    gridY2: coordSchema('gridY2', '新的右下角 Y 格点')
  },
  required: ['windowId']
};

const PARAMETERS_REMOVE = {
  type: 'object',
  properties: {
    windowId: { type: 'string', description: '要删除的窗口 ID' }
  },
  required: ['windowId']
};

const PARAMETERS_PAGE_CREATE = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '可选，页名（默认「第 N 页」）' }
  }
};

const PARAMETERS_PAGE_DELETE = {
  type: 'object',
  properties: {
    page: { type: 'number', description: '要删除的页号（1 开始）。该页上的所有窗口会一并删除' }
  },
  required: ['page']
};

const PARAMETERS_PANEL_OPEN = {
  type: 'object',
  properties: {
    windowId: { type: 'string', description: '要全屏打开的面板 / 窗口 ID' }
  },
  required: ['windowId']
};

const PARAMETERS_EMPTY = { type: 'object', properties: {} };

/** 文本输出：模型只需要读一段可读的结果说明 */
function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }]
  };
}

function rectSummary(meta) {
  const widthRatio = ((meta.x2 - meta.x1) / GRID_SIZE) * 100;
  const heightRatio = ((meta.y2 - meta.y1) / GRID_SIZE) * 100;
  return `grid (${meta.x1},${meta.y1}) → (${meta.x2},${meta.y2})，约占屏幕 ${widthRatio.toFixed(1)}% × ${heightRatio.toFixed(1)}%`;
}

function metaJson(meta) {
  return {
    windowId: meta.id,
    kind: meta.kind,
    page: meta.page + 1,
    title: meta.title,
    text: meta.text || undefined,
    targetId: meta.targetId || undefined,
    url: meta.url || undefined,
    revision: meta.rev,
    grid: { x1: meta.x1, y1: meta.y1, x2: meta.x2, y2: meta.y2 }
  };
}

/** 校验一段（可能是局部的）矩形参数 */
function rectFromArgs(args, fallback) {
  const pick = (name, index) => (args[name] === undefined ? fallback[index] : args[name]);
  return assertRect({
    x1: pick('gridX1', 'x1'),
    y1: pick('gridY1', 'y1'),
    x2: pick('gridX2', 'x2'),
    y2: pick('gridY2', 'y2')
  });
}

/** 1 基页号 → 0 基索引 */
function pageIndexFromArgs(page, pageCount) {
  if (page === undefined || page === null) return 0;
  if (typeof page !== 'number' || !Number.isInteger(page)) {
    throw new Error('page 必须是整数（1 开始）');
  }
  if (page < 1 || page > pageCount) {
    throw new Error(`page 超出范围：当前共 ${pageCount} 页，合法值为 1-${pageCount}`);
  }
  return page - 1;
}

/**
 * 注册全部工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ registry: import('./windows.js').WindowRegistry }} runtime
 */
export function registerTools(ctx, runtime) {
  const { registry } = runtime;
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('dsh-grid-ui 需要 tools 服务，无法注册工具');
  }

  // ---------------------------------------------------------------- create
  tools.register({
    name: 'create_ui_window',
    description:
      '在 DSH 界面的 200x200 逻辑网格中创建自定义 UI（窗口 / 按钮 / 全屏面板），窗口内可渲染任意 HTML（表单、图表、滑块、输入框、按钮、Canvas 等）。' +
      '窗口用百分比定位，DSH 窗口缩放时布局不变形。' +
      '网格坐标：左上角为 (0,0)，右下角为 (200,200)；例如整屏的一半宽、上半屏为 gridX1=0, gridY1=0, gridX2=100, gridY2=100。' +
      'kind=button 时画一个按钮，点击后整屏弹出它的面板页（kind=panel 的内容，或按钮自己的 html）。' +
      '页面可通过 window.dsh 与 DSH 真实交互：dsh.setThinkingLevel、dsh.sendMessage、dsh.setModel、dsh.setPermission、' +
      'dsh.cancelTurn、dsh.listSessions、dsh.readHistory、dsh.getState、dsh.onState、dsh.page.next/prev/new、dsh.openPanel 等。' +
      '页面在沙箱 iframe 中运行（sandbox="allow-scripts allow-forms"），不能使用 document.cookie、localStorage，也不能外链 http(s) 的 script。' +
      '如果想直接把某个网页嵌进来（当浏览器用），传 url（http/https）而不是 html；页面里的 HTML 也可以用 dsh.http(url, options) 调外部 API（由 Host 代理，绕开浏览器 CORS）。' +
      '图片与圆形元素请用 aspect-ratio 或 object-fit: contain 保持等比缩放。' +
      '用户需要处于「自定义 UI 模式」（点击悬浮球）才能看到；插件会在首次创建时自动帮用户切换。',
    parameters: PARAMETERS_CREATE,
    output: textOutput(),
    async execute(args) {
      const page = pageIndexFromArgs(args.page, registry.pageCount);
      // 面板页默认铺满整屏（rect 对它没有视觉意义，但注册表仍要求一个合法矩形）
      const noRectGiven =
        args.gridX1 === undefined && args.gridY1 === undefined && args.gridX2 === undefined && args.gridY2 === undefined;
      const rect =
        args.kind === 'panel' && noRectGiven
          ? { x1: 0, y1: 0, x2: GRID_SIZE, y2: GRID_SIZE }
          : rectFromArgs(args, {});
      let checkedHtml;
      if (args.html !== undefined) {
        const checked = sanitizeHtml(args.html);
        if (!checked.ok) throw new Error(`html 校验未通过：${checked.error}`);
        checkedHtml = checked.html;
      } else if ((args.kind === 'window' || args.kind === 'panel') && !args.url) {
        throw new Error('kind=window / panel 必须提供 html 或 url');
      }

      const meta = registry.upsert({
        id: args.windowId,
        kind: args.kind,
        html: checkedHtml,
        title: typeof args.title === 'string' ? args.title : undefined,
        text: typeof args.text === 'string' ? args.text : undefined,
        targetId: typeof args.targetId === 'string' ? args.targetId : undefined,
        url: typeof args.url === 'string' ? args.url : undefined,
        rect,
        page
      });

      // 让客户端自动翻到这一页（面板不跳，避免用户正看到一半被打断）
      if (meta.kind !== 'panel') runtime.cache.focusPage = { page: meta.page, at: Date.now() };

      const kindText = { window: '窗口', button: '按钮', panel: '面板页' }[meta.kind] || meta.kind;      const lines = [
        `已创建${kindText} "${meta.id}"（第 ${meta.page + 1} 页）：${rectSummary(meta)}。`,
        `当前第 ${meta.page + 1} 页共有 ${registry.listPages()[meta.page].windows}/${MAX_WINDOWS_PER_PAGE} 个窗口，共 ${registry.pageCount} 页。`,
        meta.kind === 'panel'
          ? '面板页平时不显示，用 open_ui_panel 或页面里的 dsh.openPanel(id) 打开。'
          : '用户若看不到，请点击悬浮球进入「自定义 UI 模式」。',
        `JSON: ${JSON.stringify(metaJson(meta))}`
      ];
      return lines.join('\n');
    }
  });

  // ---------------------------------------------------------------- update
  tools.register({
    name: 'update_ui_window',
    description:
      '更新指定窗口的 HTML 内容、位置、类型、按钮文字、目标面板或所属页（可只更新其中一部分）。' +
      '只传 html 则保持原位置；只传 gridX1/gridY1/gridX2/gridY2 则保持原内容。',
    parameters: PARAMETERS_UPDATE,
    output: textOutput(),
    async execute(args) {
      const windowId = args.windowId;
      const current = registry.get(windowId);
      if (!current) throw new Error(`窗口不存在：${windowId}`);

      let checkedHtml;
      if (args.html !== undefined) {
        const checked = sanitizeHtml(args.html);
        if (!checked.ok) throw new Error(`html 校验未通过：${checked.error}`);
        checkedHtml = checked.html;
      }

      const hasRect =
        args.gridX1 !== undefined ||
        args.gridY1 !== undefined ||
        args.gridX2 !== undefined ||
        args.gridY2 !== undefined;
      const rect = hasRect
        ? rectFromArgs(args, { x1: current.x1, y1: current.y1, x2: current.x2, y2: current.y2 })
        : undefined;
      const page =
        args.page === undefined ? undefined : pageIndexFromArgs(args.page, registry.pageCount);

      const meta = registry.patch(windowId, {
        html: checkedHtml,
        rect,
        kind: args.kind === undefined ? undefined : args.kind,
        text: args.text,
        targetId: args.targetId,
        page,
        url: args.url
      });
      const urlNote =
        args.url === undefined
          ? ''
          : meta.url
            ? `；改为网址窗口 ${meta.url}`
            : '；改回 HTML 窗口';
      return [
        `已更新窗口 "${meta.id}"（revision ${meta.rev}）：${rectSummary(meta)}${urlNote}。`,
        `${args.html === undefined && args.url === undefined ? '内容保持不变' : '内容已替换'}；${hasRect ? '位置已更新' : '位置保持不变'}；当前在第 ${meta.page + 1} 页。`,
        `JSON: ${JSON.stringify(metaJson(meta))}`
      ].join('\n');
    }
  });

  // ---------------------------------------------------------------- remove
  tools.register({
    name: 'remove_ui_window',
    description: '删除指定 ID 的自定义 UI 窗口（窗口 / 按钮 / 面板均可）。不存在时不报错，返回 removed=false。',
    parameters: PARAMETERS_REMOVE,
    output: textOutput(),
    async execute(args) {
      let removed = false;
      try {
        removed = registry.remove(args.windowId);
      } catch (error) {
        if (error instanceof GridUiError) throw new Error(error.message);
        throw error;
      }
      return [
        removed ? `已删除窗口 "${args.windowId}"。` : `窗口 "${args.windowId}" 不存在，无需删除。`,
        `当前共 ${registry.size} 个窗口，${registry.pageCount} 页。`
      ].join('\n');
    }
  });

  // ---------------------------------------------------------------- pages
  tools.register({
    name: 'create_ui_page',
    description:
      '新建一张画布页（空白页），用于做多页自定义 UI（像 PPT 一样，每页放不同的窗口 / 按钮 / 面板）。' +
      '新建后可以用 create_ui_window 的 page 参数把窗口放到这一页。',
    parameters: PARAMETERS_PAGE_CREATE,
    output: textOutput(),
    async execute(args) {
      const index = registry.addPage(typeof args.name === 'string' ? args.name : undefined);
      const pages = registry.listPages();
      return [
        `已新建第 ${index + 1} 页（空白）。当前共 ${pages.length}/${MAX_PAGES} 页。`,
        `页列表：${pages.map((p) => `第${p.index + 1}页「${p.name}」${p.windows}个窗口`).join('；')}`
      ].join('\n');
    }
  });

  tools.register({
    name: 'delete_ui_page',
    description: '删除指定页（1 开始）以及该页上的所有窗口。只有画布只剩一页时才会被拒绝（至少保留一页）。',
    parameters: PARAMETERS_PAGE_DELETE,
    output: textOutput(),
    async execute(args) {
      const index = pageIndexFromArgs(args.page, registry.pageCount);
      const result = registry.removePage(index);
      return [
        `已删除第 ${args.page} 页，同时删除该页 ${result.removedWindows} 个窗口。`,
        `当前剩余 ${registry.pageCount} 页。`
      ].join('\n');
    }
  });

  // ---------------------------------------------------------------- panels
  tools.register({
    name: 'open_ui_panel',
    description:
      '把一个面板 / 窗口全屏打开，铺满整个 DSH 窗口（右上角有关闭按钮）。' +
      '用于 kind=panel 的页面，或想让某个普通窗口临时全屏展示。',
    parameters: PARAMETERS_PANEL_OPEN,
    output: textOutput(),
    async execute(args) {
      const target = registry.get(args.windowId);
      if (!target) throw new Error(`窗口不存在：${args.windowId}`);
      runtime.cache.panel = { id: args.windowId, at: Date.now() };
      return `已打开面板 "${args.windowId}"（全屏）。用户可点右上角关闭，或调用 close_ui_panel。`;
    }
  });

  tools.register({
    name: 'close_ui_panel',
    description: '关闭当前全屏面板（如果没开则不报错）。',
    parameters: PARAMETERS_EMPTY,
    output: textOutput(),
    async execute() {
      runtime.cache.panel = null;
      return '已关闭全屏面板。';
    }
  });
}
