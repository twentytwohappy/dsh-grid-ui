/**
 * dsh-grid-ui · host/actions.js
 * 处理来自 iframe 的 dsh-action 指令，把浏览器里的交互落到真实的 DSH 状态上。
 *
 * 依赖的 DSH 服务（全部用 ctx.get(name) 软获取，缺失时给出可读错误）：
 *  - sessionController    → selectModel / prompt
 *  - sessions             → 按 sessionId 取活的 Session 对象（权限、投影需要）
 *  - sessionProjections   → 读 modelSelection 投影，得到会话真实的模型选择
 *  - permissionPresets    → catalog / current / set（权限预设）
 *  - agentDefaultModel    → 兜底读取默认模型选择
 *  - llm / attachments    → 由 catalog.js 与 sessionController.prompt 间接使用
 *
 * 关键 API 参考：
 *  - @deepseek-ai/dsh-api-session-controller#session/selectModel
 *      { sessionId, provider, model, reasoningEffort? } → { selected }
 *  - @deepseek-ai/dsh-api-session-controller#session/prompt
 *      { sessionId, content: [{type:'text',text} | {type:'image',data,mediaType,name?}], requestId? }
 *      → { accepted: true }；图片由 ctx.attachments.admitPromptContent 落盘为 attachment
 *  - @deepseek-ai/dsh-permission-presets
 *      catalog() → { options: [{value,name,description?}], defaultPreset }
 *      current(session) → name；set(session, name)
 *  - @deepseek-ai/dsh-agent-default-model
 *      currentSelection() → { provider, model, reasoningEffort? }
 */

import { captureRegion } from './electron.js';

/** reasoning effort 的基础约束（真实可用值来自模型的 efforts 目录） */
const EFFORT_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

/** 一次 prompt 允许附带的图片数量 / 单张 base64 长度上限 */
const MAX_IMAGES_PER_MESSAGE = 6;
const MAX_IMAGE_BASE64_CHARS = 12 * 1024 * 1024;

/**
 * sessionController.prompt 的**第二个位置参数**是 AbortSignal：
 *
 *   prompt(request, signal) { signal.throwIfAborted(); return this.commands.prompt(request); }
 *   —— @deepseek-ai/dsh-api-session-controller/lib/index.js:3096-3099
 *
 * 少传就会得到 `Cannot read properties of undefined (reading 'throwIfAborted')`。
 * 插件这一层没有可取消的调用方生命周期，所以用一个永不 abort 的信号；
 * 该信号只在入口处被检查一次，不会影响后续 turn 的运行。
 */
const LIFETIME_SIGNAL = new AbortController().signal;

export class ActionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ActionError';
    this.code = code || 'grid-ui/action-failed';
  }
}

/** 软获取服务；cordis 的 ctx.get 在服务不存在时返回 undefined */
function service(ctx, name) {
  try {
    return ctx.get(name);
  } catch (error) {
    return undefined;
  }
}

function requireController(ctx) {
  const controller = service(ctx, 'sessionController');
  if (!controller) {
    throw new ActionError(
      '当前部署没有 sessionController 服务，无法执行会话操作',
      'grid-ui/no-session-controller'
    );
  }
  return controller;
}

/** 取活着的 Session 对象（权限预设与投影都以它为单位，而不是 sessionId 字符串）。 */
function liveSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  const sessions = service(ctx, 'sessions');
  if (!sessions || typeof sessions.get !== 'function') return undefined;
  try {
    return sessions.get(sessionId);
  } catch (error) {
    return undefined;
  }
}

/**
 * 解析当前模型选择，优先级：
 *  1. 会话的 modelSelection 投影（用户可能在 DSH 原生界面里改过）
 *  2. 本进程内 selectModel 的返回值缓存
 *  3. agentDefaultModel 的默认值
 */
function resolveSelection(ctx, cache, sessionId) {
  const session = liveSession(ctx, sessionId);
  if (session) {
    const projections = service(ctx, 'sessionProjections');
    if (projections && typeof projections.stateOf === 'function') {
      try {
        const state = projections.stateOf(session, 'modelSelection');
        const selection = state ? state.pending ?? state.lastUsed : undefined;
        if (selection && selection.provider && selection.model) return { ...selection };
      } catch (error) {
        /* 投影不可用则继续兜底 */
      }
    }
  }

  if (cache.selection) return { ...cache.selection };

  const defaults = service(ctx, 'agentDefaultModel');
  if (defaults && typeof defaults.currentSelection === 'function') {
    try {
      const current = defaults.currentSelection();
      if (current && current.provider && current.model) {
        cache.selection = { ...current };
        return { ...current };
      }
    } catch (error) {
      /* 读不到就当未知 */
    }
  }
  return undefined;
}

/**
 * 按会话读一页历史，并处理「throughSeq 超过持久化光标」这个坑。
 *
 * 为什么需要兜底：`sessionController.page()`（dsh-api-session-controller/lib/index.js:1424）
 * 用 `sourceLog.at(-1).seq` 当光标，而 SessionHandle.seq 会**领先于**持久化日志
 * （刚 append 还没落盘的那一条）。于是直接传 `live.seq` 会撞上
 * `session page through seq 6542 is past cursor 6541`（gateway/bad-request）。
 * 这里先按 handle.seq 读；被拒就从错误信息里取出真实光标再读一次。
 */
export async function readHistoryPage(controller, sessionId, headSeq, maxMessages) {
  const request = (throughSeq) =>
    controller.page(
      { address: { kind: 'session', sessionId }, throughSeq, maxMessages },
      LIFETIME_SIGNAL
    );

  const head = typeof headSeq === 'number' && headSeq >= 0 ? headSeq : -1;
  try {
    return await request(head);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /past cursor (-?\d+)/.exec(message);
    if (!match) throw error;
    const cursor = Number(match[1]);
    if (!Number.isFinite(cursor) || cursor < 0) throw error;
    return await request(cursor);
  }
}

function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new ActionError(
      '缺少会话标识：请先打开一个 DSH 会话（浏览器端会自动带上 sessionId）',
      'grid-ui/no-session'
    );
  }
  return sessionId;
}

/**
 * 读当前权限预设，返回 { value, source, sandbox, approval }。
 *
 * 为什么不直接 `presets.current(session)` 就完事：
 * `permissionPresets.current()`（见 @deepseek-ai/dsh-permission-presets/lib/index.js:291-306）
 * 是「拿 sandbox + approval 两个旋钮反推预设名」的推导，反推不中会返回 `custom`，
 * 而 UI 的下拉只认 catalog 里的 key —— 于是会出现「权限改了、确实生效、但下拉显示不对」。
 * 另外没有活会话时（刚重启、还没发消息）连 session 对象都取不到，只能退默认值。
 *
 * 因此这里按可靠性从高到低三级兜底：
 *   1. 会话投影（最权威，能拿到就用）
 *   2. 本进程最近一次 set_permission 写成功的值（读回慢一拍时不会「跳回旧权限」）
 *   3. 部署默认值
 */
function resolvePermission(ctx, cache, sessionId) {
  const presets = service(ctx, 'permissionPresets');
  if (!presets) return { value: null, source: 'none', sandbox: null, approval: null };
  const effectiveId = sessionId || (cache ? cache.lastSessionId : undefined);
  const session = liveSession(ctx, effectiveId);

  let sandbox = null;
  let approval = null;
  if (session && typeof presets.permissionState === 'function') {
    try {
      const knobs = presets.permissionState(session);
      if (knobs && typeof knobs === 'object') {
        if (typeof knobs.sandbox === 'string') sandbox = knobs.sandbox;
        if (typeof knobs.approval === 'string') approval = knobs.approval;
      }
    } catch (error) {
      /* 投影还没注册，忽略 */
    }
  }

  if (session) {
    const value = safeCurrent(presets, session);
    if (typeof value === 'string' && value !== '') {
      return { value, source: 'session', sandbox, approval };
    }
  }

  if (cache && cache.permission && cache.permission.sessionId === effectiveId) {
    const value = cache.permission.value;
    if (typeof value === 'string' && value !== '') {
      return { value, source: 'cache', sandbox, approval };
    }
  }

  const fallback = typeof presets.defaultPreset === 'string' ? presets.defaultPreset : null;
  return { value: fallback, source: fallback ? 'default' : 'none', sandbox, approval };
}

/** 安全地读一次 presets.current（异常返回 undefined）。 */
function safeCurrent(presets, session) {
  try {
    return presets.current(session);
  } catch (error) {
    return undefined;
  }
}

/**
 * 把「展示名」或「key」都归一成 presets.set 需要的 key。
 * catalog 的选项形如 { value: 'workspace-write', name: 'workspace-write' }，
 * 上层 UI 可能传任意一个。
 */
async function resolvePresetKey(runtime, presets, wanted) {
  if (typeof presets.resolve === 'function') {
    try {
      presets.resolve(wanted);
      return wanted;
    } catch (error) {
      /* 不是 key，继续按展示名找 */
    }
  }
  let options = [];
  try {
    const info = await runtime.catalog.catalog();
    options = Array.isArray(info?.permissions) ? info.permissions : [];
  } catch (error) {
    options = [];
  }
  const hit = options.find(
    (option) => option && (option.name === wanted || option.value === wanted)
  );
  if (hit && typeof hit.value === 'string') return hit.value;
  return wanted; // 交给 presets.set 抛它自己的 unknown-preset 错误
}

/**
 * 等权限投影落定：presets.current 在 set 之后要过一拍才反映新值。
 * 60ms 一次、最多 timeout 毫秒；命中返回 true。
 */
async function waitForPermission(presets, session, expected, timeout) {
  if (safeCurrent(presets, session) === expected) return true;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (safeCurrent(presets, session) === expected) return true;
  }
  return false;
}

/**
 * 组装推送给浏览器的状态快照（对应需求 3.4 的 dsh-state）。
 * @returns {Promise<object>}
 */
export async function buildState(ctx, runtime, sessionId) {
  const { registry, cache, catalog } = runtime;
  const selection = resolveSelection(ctx, cache, sessionId);
  const efforts = selection ? await catalog.effortsOf(selection.provider, selection.model) : [];
  const permission = resolvePermission(ctx, cache, sessionId);

  return {
    sessionId: sessionId || cache.lastSessionId || null,
    windows: registry.list().length, // 只统计画布可见窗口，面板另计
    thinkingLevel: selection && selection.reasoningEffort ? selection.reasoningEffort : null,
    activeModel:
      selection && selection.provider && selection.model
        ? { provider: selection.provider, model: selection.model }
        : null,
    efforts,
    permission: permission.value,
    // 权限读回的来源与底层旋钮：UI 可以据此判断「这个值可不可信」并做兜底展示
    permissionSource: permission.source,
    permissionKnobs:
      permission.sandbox || permission.approval
        ? { sandbox: permission.sandbox, approval: permission.approval }
        : null,
    // 画布页（index 0 基，客户端展示成 1 基）与当前打开的面板
    pages: registry.listPages(),
    pageCount: registry.pageCount,
    // AI 刚在某一页创建/移动了窗口时，让客户端自动翻到那一页（at 防止重复跳）
    focusPage: cache.focusPage ? { page: cache.focusPage.page, at: cache.focusPage.at } : null,
    openPanel: cache.panel ? { id: cache.panel.id, at: cache.panel.at } : null,
    // 供 AI 生成的页面做能力探测：v0.4 起覆盖「会话 / 模型 / 权限 / 消息 / 画布 / 面板」
    capabilities: [
      'get_state',
      'catalog',
      'set_thinking_level',
      'set_model',
      'set_permission',
      'send_message',
      'cancel',
      'list_sessions',
      'new_session',
      'rename_session',
      'search_sessions',
      'read_history',
      'read_attachment',
      'page_new',
      'page_delete',
      'page_rename',
      'open_panel',
      'close_panel',
      'get_feed',
      'http',
      'capture_window',
      'cookie'
    ]
  };
}

async function selectModel(ctx, request) {
  const controller = requireController(ctx);
  // 主路径：sessionController.selectModel（@Remote('selectModel')）
  if (typeof controller.selectModel !== 'function') return selectModelFallback(ctx, request);
  try {
    const result = await controller.selectModel(request);
    const selected = result && result.selected ? result.selected : request;
    return {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selected.reasoningEffort })
    };
  } catch (error) {
    throw new ActionError(
      `切换模型失败：${error instanceof Error ? error.message : String(error)}`,
      'grid-ui/select-model-failed'
    );
  }
}

/**
 * 兜底路径：直接走命令层内部用的那两个公开能力
 * （对应 @deepseek-ai/dsh-api-session-controller/lib/types/commands.js:145-176 的实现）：
 *   agents.selectForNextRequest(agent, selection)  → 本会话下一次请求用新模型
 *   agentDefaultModel.saveSelection(selection)     → 记住为默认选择
 */
function selectModelFallback(ctx, request) {
  const selection = {
    provider: request.provider,
    model: request.model,
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort })
  };
  const agents = service(ctx, 'agents');
  const agent =
    agents && typeof agents.get === 'function' ? agents.get(request.sessionId) : undefined;
  if (!agent || typeof agents.selectForNextRequest !== 'function') {
    throw new ActionError(
      '当前部署无法切换模型：sessionController.selectModel 与 agents.selectForNextRequest 均不可用',
      'grid-ui/no-select-model'
    );
  }
  agents.selectForNextRequest(agent, selection);
  const defaults = service(ctx, 'agentDefaultModel');
  if (defaults && typeof defaults.saveSelection === 'function') {
    Promise.resolve(defaults.saveSelection(selection)).catch(() => {
      /* 默认值保存失败不影响本次会话内的切换 */
    });
  }
  return selection;
}

/** 把浏览器传来的图片整理成 prompt 的 image 内容块（去掉 data URL 前缀）。 */
function imageBlocks(payload) {
  const raw = Array.isArray(payload.images) ? payload.images : [];
  const blocks = [];
  for (const item of raw.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    if (!item || typeof item !== 'object') continue;
    let data = typeof item.data === 'string' ? item.data : '';
    data = data.replace(/^data:[^;,]*(;[^,]*)?,/, '');
    if (data.length === 0) continue;
    if (data.length > MAX_IMAGE_BASE64_CHARS) {
      throw new ActionError(
        `单张图片太大（base64 ${Math.round(data.length / 1024)} KB，上限 ${MAX_IMAGE_BASE64_CHARS / 1024} KB）`,
        'grid-ui/image-too-large'
      );
    }
    const mediaType =
      typeof item.mediaType === 'string' && item.mediaType.startsWith('image/')
        ? item.mediaType
        : 'image/png';
    blocks.push({
      type: 'image',
      data,
      mediaType,
      ...(typeof item.name === 'string' && item.name ? { name: item.name } : {})
    });
  }
  return blocks;
}

/**
 * 执行一条来自 iframe 的动作。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ registry: import('./windows.js').WindowRegistry, cache: object, catalog: object }} runtime
 * @param {{ sessionId?: string, action?: string, payload?: object }} body
 */
export async function handleAction(ctx, runtime, body) {
  const { cache } = runtime;
  const action = typeof body.action === 'string' ? body.action : '';
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
  const sessionId =
    typeof body.sessionId === 'string' && body.sessionId !== ''
      ? body.sessionId
      : cache.lastSessionId;

  if (sessionId) cache.lastSessionId = sessionId;

  switch (action) {
    case 'get_state': {
      return { ok: true, state: await buildState(ctx, runtime, sessionId) };
    }

    case 'catalog': {
      return {
        ok: true,
        catalog: await runtime.catalog.catalog(payload.force === true),
        state: await buildState(ctx, runtime, sessionId)
      };
    }

    /**
     * 记住用户选择的界面模式（custom / native）。
     *
     * 为什么不做 Host 侧写盘：DSH 的 settings 服务（@deepseek-ai/dsh-settings 的
     * SettingsForms）只暴露 update/replace/mutate/write 这一组「配置表单」接口，
     * 签名是 (ns, patch|ops, expectedRevision)，写的是某个插件条目的 volatile 配置字段，
     * 既没有 ctx.settings.set() 这种便捷方法，也不适合存纯粹的界面偏好。
     * 模式偏好属于「这台机器的浏览器」，因此由 client 端 localStorage 保存；
     * 这里只把最新值同步到 runtime.config 供本次进程内读取，保证热重载后不丢。
     */
    case 'set_mode': {
      const mode = payload.mode;
      if (mode !== 'custom' && mode !== 'native') {
        throw new ActionError('set_mode 需要 mode 为 "custom" 或 "native"', 'grid-ui/bad-mode');
      }
      runtime.config.mode = mode;
      return { ok: true, mode, persisted: false };
    }

    case 'set_permission': {
      const wanted = typeof payload.preset === 'string' ? payload.preset.trim() : '';
      if (wanted === '') {
        throw new ActionError('set_permission 需要 preset 字符串', 'grid-ui/bad-preset');
      }
      const presets = service(ctx, 'permissionPresets');
      if (!presets || typeof presets.set !== 'function') {
        throw new ActionError('当前部署没有 permissionPresets 服务', 'grid-ui/no-permissions');
      }
      // 允许两种写法：预设 key（workspace-write）或 catalog 里的展示名。
      const preset = await resolvePresetKey(runtime, presets, wanted);
      const sid = requireSessionId(sessionId || cache.lastSessionId);
      const session = liveSession(ctx, sid);
      if (!session) {
        throw new ActionError(
          '会话不在运行中，无法切换权限预设；请先在该会话里发一条消息',
          'grid-ui/no-live-session'
        );
      }
      try {
        presets.set(session, preset);
      } catch (error) {
        throw new ActionError(
          `切换权限失败：${error instanceof Error ? error.message : String(error)}`,
          'grid-ui/set-permission-failed'
        );
      }
      // 权限写在 session 的投影里，投影刷新有一拍延迟；这里等它落定，
      // 免得 UI 立刻回读旧值、看起来像「自己跳回原权限」。
      // 注意：即使读回不是期望值也不抛错 —— 写入本身已经生效（用户实测如此），
      // 抛错只会让 UI 显示失败。用一个 `confirmed` 字段把真相告诉调用方。
      const applied = await waitForPermission(presets, session, preset, 600);
      // 记下这次写入：投影读回慢／反推出 `custom` 时，/state 仍能显示正确预设，
      // 不会出现「改了权限、确实生效、下拉却跳回原来的」。
      cache.permission = { sessionId: sid, value: preset, at: Date.now() };
      return {
        ok: true,
        permission: preset,
        permissionConfirmed: applied,
        state: await buildState(ctx, runtime, sid)
      };
    }

    case 'set_thinking_level': {
      const level = payload.level;
      if (typeof level !== 'string' || !EFFORT_PATTERN.test(level)) {
        throw new ActionError('set_thinking_level 需要一个合法的 level 字符串', 'grid-ui/bad-level');
      }
      const selection = resolveSelection(ctx, cache, sessionId);
      if (!selection) {
        throw new ActionError(
          '无法确定当前模型：请先用 set_model 指定 provider 与 model',
          'grid-ui/unknown-model'
        );
      }
      const selected = await selectModel(ctx, {
        sessionId: requireSessionId(sessionId),
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: level
      });
      cache.selection = selected;
      return {
        ok: true,
        selected,
        state: await buildState(ctx, runtime, sessionId)
      };
    }

    case 'set_model': {
      const provider = payload.provider;
      const model = payload.model;
      if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
        throw new ActionError('set_model 需要 provider 与 model 两个字符串', 'grid-ui/bad-model');
      }
      const current = resolveSelection(ctx, cache, sessionId);
      const selected = await selectModel(ctx, {
        sessionId: requireSessionId(sessionId),
        provider,
        model,
        ...(current && current.reasoningEffort
          ? { reasoningEffort: current.reasoningEffort }
          : {})
      });
      cache.selection = selected;
      return {
        ok: true,
        selected,
        state: await buildState(ctx, runtime, sessionId)
      };
    }

    case 'send_message': {
      const text = typeof payload.text === 'string' ? payload.text : '';
      const images = imageBlocks(payload);
      if (text.trim() === '' && images.length === 0) {
        throw new ActionError('send_message 需要非空 text 或至少一张图片', 'grid-ui/empty-message');
      }

      const content = [];
      if (text.trim() !== '') content.push({ type: 'text', text });
      for (const image of images) content.push(image);

      const controller = requireController(ctx);
      const requestId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `dsh-grid-ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        const result = await controller.prompt(
          {
            sessionId: requireSessionId(sessionId),
            content,
            requestId
          },
          // 位置参数：AbortSignal。缺失时服务内部 signal.throwIfAborted() 会炸。
          LIFETIME_SIGNAL
        );
        return {
          ok: true,
          accepted: Boolean(result && result.accepted !== false),
          images: images.length,
          state: await buildState(ctx, runtime, sessionId)
        };
      } catch (error) {
        throw new ActionError(
          `发送消息失败：${error instanceof Error ? error.message : String(error)}`,
          'grid-ui/prompt-failed'
        );
      }
    }

    // ---------------------------------------------------------- 截图 / cookie
    //
    // 这两组能力让「一个窗口」能拿到「另一个窗口」的像素与登录态：
    //   capture_window → 用 Electron 的 webContents.capturePage() 抓整页，按窗口的
    //                    百分比矩形裁剪，返回 base64（页面再喂给 dsh.sendMessage 当附件）
    //   cookie         → 读写 Host 侧共享 cookie 罐（所有窗口 + dsh.http 同一份）

    case 'capture_window': {
      const id =
        typeof payload.windowId === 'string'
          ? payload.windowId
          : typeof payload.id === 'string'
            ? payload.id
            : '';
      if (id === '') throw new ActionError('capture_window 需要 windowId', 'grid-ui/bad-window-id');
      const target = runtime.registry.get(id);
      if (!target) throw new ActionError(`窗口不存在: ${id}`, 'grid-ui/no-window');
      const shot = await captureRegion(target, {
        format: payload.format,
        quality: payload.quality,
        maxWidth: payload.maxWidth
      });
      return {
        ok: true,
        windowId: id,
        mediaType: shot.mediaType,
        data: shot.buffer.toString('base64'),
        bytes: shot.buffer.length,
        width: shot.width,
        height: shot.height,
        rect: { x1: target.x1, y1: target.y1, x2: target.x2, y2: target.y2 }
      };
    }

    case 'cookie': {
      const jar = runtime.cookies;
      if (!jar) throw new ActionError('cookie 罐未初始化', 'grid-ui/no-cookies');
      const op = typeof payload.op === 'string' ? payload.op : 'list';
      if (op === 'list') {
        return {
          ok: true,
          cookies: jar.list({ url: payload.url, domain: payload.domain }).map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expires: cookie.expires,
            sameSite: cookie.sameSite
          }))
        };
      }
      if (op === 'set') {
        const url = typeof payload.url === 'string' ? payload.url : '';
        let parsed = null;
        try {
          parsed = new URL(url);
        } catch (error) {
          throw new ActionError(`url 不是合法地址：${url || '(空)'}`, 'grid-ui/bad-url');
        }
        const name = typeof payload.name === 'string' ? payload.name.trim() : '';
        if (name === '') throw new ActionError('设置 cookie 需要 name', 'grid-ui/bad-cookie');
        const stored = jar.store({
          name,
          value: typeof payload.value === 'string' ? payload.value : '',
          domain:
            typeof payload.domain === 'string' && payload.domain
              ? payload.domain.replace(/^\./, '').toLowerCase()
              : parsed.hostname.toLowerCase(),
          hostOnly: typeof payload.domain === 'string' ? payload.domain === '' : true,
          path: typeof payload.path === 'string' && payload.path.startsWith('/') ? payload.path : '/',
          secure: payload.secure === true,
          httpOnly: payload.httpOnly === true,
          expires: Number.isFinite(payload.expires) ? payload.expires : null,
          sameSite: typeof payload.sameSite === 'string' ? payload.sameSite : null
        });
        return { ok: true, stored, size: jar.map.size };
      }
      if (op === 'remove') {
        const url = typeof payload.url === 'string' ? payload.url : '';
        try {
          new URL(url);
        } catch (error) {
          throw new ActionError(`url 不是合法地址：${url || '(空)'}`, 'grid-ui/bad-url');
        }
        const removed = jar.remove(url, typeof payload.name === 'string' ? payload.name : '');
        return { ok: true, removed, size: jar.map.size };
      }
      if (op === 'clear') {
        return { ok: true, cleared: jar.clear() };
      }
      throw new ActionError(`未知的 cookie op: ${op}`, 'grid-ui/bad-cookie-op');
    }

    // ------------------------------------------------------------ 会话能力
    //
    // 对应 @deepseek-ai/dsh-api-session-controller 的 Remote 方法族。自定义 UI 里
    // 的页面因此可以列出会话、开新会话、读历史、读图片、停止当前回合 —— 这些是
    // DSH 原生界面里能做的、与「会话」相关的主要能力。

    case 'list_sessions': {
      const controller = requireController(ctx);
      if (typeof controller.list !== 'function') {
        throw new ActionError('当前部署的 sessionController 不支持 list', 'grid-ui/no-list');
      }
      const value = await controller.list({}, LIFETIME_SIGNAL);
      const items = Array.isArray(value && value.items) ? value.items : [];
      return {
        ok: true,
        sessions: items.map((item) => ({
          sessionId: item.sessionId,
          title: item.title || null,
          updatedAt: item.updatedAt || item.lastActiveAt || null,
          ...(item.origin ? { origin: item.origin } : {})
        })),
        state: await buildState(ctx, runtime, sessionId)
      };
    }

    case 'new_session': {
      const controller = requireController(ctx);
      if (typeof controller.create !== 'function') {
        throw new ActionError('当前部署的 sessionController 不支持 create', 'grid-ui/no-create');
      }
      try {
        const created = await controller.create({});
        const newId = created && created.sessionId ? created.sessionId : null;
        if (newId) cache.lastSessionId = newId;
        return { ok: true, sessionId: newId, state: await buildState(ctx, runtime, newId || sessionId) };
      } catch (error) {
        throw new ActionError(
          `新建会话失败：${error instanceof Error ? error.message : String(error)}`,
          'grid-ui/create-failed'
        );
      }
    }

    case 'rename_session': {
      const controller = requireController(ctx);
      const target = payload.sessionId || sessionId;
      const title = typeof payload.title === 'string' ? payload.title.trim() : '';
      if (!title) throw new ActionError('rename_session 需要非空 title', 'grid-ui/bad-title');
      if (typeof controller.rename !== 'function') {
        throw new ActionError('当前部署的 sessionController 不支持 rename', 'grid-ui/no-rename');
      }
      const value = await controller.rename({ sessionId: requireSessionId(target), title });
      return { ok: true, title: value && value.title ? value.title : title, state: await buildState(ctx, runtime, sessionId) };
    }

    case 'search_sessions': {
      const controller = requireController(ctx);
      const query = typeof payload.query === 'string' ? payload.query.trim() : '';
      if (!query) throw new ActionError('search_sessions 需要非空 query', 'grid-ui/bad-query');
      if (typeof controller.search !== 'function') {
        throw new ActionError('当前部署的 sessionController 不支持 search', 'grid-ui/no-search');
      }
      const value = await controller.search({ query }, LIFETIME_SIGNAL);
      return { ok: true, result: value || null, state: await buildState(ctx, runtime, sessionId) };
    }

    case 'read_history': {
      const controller = requireController(ctx);
      const target = requireSessionId(payload.sessionId || sessionId);
      if (typeof controller.page !== 'function') {
        throw new ActionError('当前部署的 sessionController 不支持 page', 'grid-ui/no-history');
      }
      const live = liveSession(ctx, target);
      if (!live) {
        throw new ActionError(
          '会话不在运行中，暂时读不到历史（请先在该会话里发一条消息）',
          'grid-ui/no-live-session'
        );
      }
      const maxMessages =
        typeof payload.maxMessages === 'number' && payload.maxMessages > 0
          ? Math.min(Math.floor(payload.maxMessages), 500)
          : 100;
      const value = await readHistoryPage(controller, target, live.seq, maxMessages);
      return {
        ok: true,
        records: value && Array.isArray(value.records) ? value.records : [],
        hasMore: Boolean(value && value.hasMore),
        state: await buildState(ctx, runtime, sessionId)
      };
    }

    case 'read_attachment': {
      const controller = requireController(ctx);
      const target = requireSessionId(payload.sessionId || sessionId);
      const attachmentId = typeof payload.attachmentId === 'string' ? payload.attachmentId : '';
      if (!attachmentId) {
        throw new ActionError('read_attachment 需要 attachmentId', 'grid-ui/bad-attachment');
      }
      if (typeof controller.attachment !== 'function') {
        throw new ActionError('当前部署的 sessionController 不支持 attachment', 'grid-ui/no-attachment');
      }
      const value = await controller.attachment({ sessionId: target, attachmentId });
      return { ok: true, attachment: value && value.attachment ? value.attachment : null, data: value && value.data ? value.data : null };
    }

    case 'cancel': {
      const controller = requireController(ctx);
      const target = requireSessionId(payload.sessionId || sessionId);
      if (typeof controller.cancel !== 'function') {
        throw new ActionError('当前部署的 sessionController 不支持 cancel', 'grid-ui/no-cancel');
      }
      try {
        const value = await controller.cancel({ sessionId: target });
        return {
          ok: true,
          accepted: Boolean(value && value.accepted !== false),
          state: await buildState(ctx, runtime, sessionId)
        };
      } catch (error) {
        throw new ActionError(
          `中止回合失败：${error instanceof Error ? error.message : String(error)}`,
          'grid-ui/cancel-failed'
        );
      }
    }

    // ------------------------------------------------------------ 画布页
    case 'page_new': {
      const index = runtime.registry.addPage(payload.name);
      return {
        ok: true,
        page: index,
        pages: runtime.registry.listPages(),
        state: await buildState(ctx, runtime, sessionId)
      };
    }

    case 'page_delete': {
      const index = Number(payload.index);
      if (!Number.isInteger(index) || index < 0) {
        throw new ActionError('page_delete 需要 index（0 基整数）', 'grid-ui/bad-page');
      }
      const result = runtime.registry.removePage(index);
      return {
        ok: true,
        removedWindows: result.removedWindows,
        pageCount: runtime.registry.pageCount,
        state: await buildState(ctx, runtime, sessionId)
      };
    }

    case 'page_rename': {
      const index = Number(payload.index);
      if (!Number.isInteger(index) || index < 0) {
        throw new ActionError('page_rename 需要 index（0 基整数）', 'grid-ui/bad-page');
      }
      runtime.registry.renamePage(index, String(payload.name || ''));
      return { ok: true, state: await buildState(ctx, runtime, sessionId) };
    }

    // ------------------------------------------------------------ 全屏面板
    case 'open_panel': {
      // 两种寻址：windowId 直接给面板窗口，或 targetId 从按钮记录里解析
      const windowId = String(payload.windowId || payload.targetId || '');
      const target = runtime.registry.get(windowId);
      if (!target) throw new ActionError(`窗口不存在: ${windowId}`, 'grid-ui/unknown-window');
      // 只有面板窗口能全屏打开：普通窗口/按钮误用会让画布元素莫名其妙占满屏
      if (target.kind !== 'panel') {
        throw new ActionError(
          `只有面板窗口（kind=panel）可以全屏打开：${windowId} 的类型是 ${target.kind}`,
          'grid-ui/not-a-panel'
        );
      }
      cache.panel = { id: windowId, at: Date.now() };
      return { ok: true, openPanel: cache.panel, state: await buildState(ctx, runtime, sessionId) };
    }

    case 'close_panel': {
      cache.panel = null;
      return { ok: true, state: await buildState(ctx, runtime, sessionId) };
    }

    case 'open_settings': {
      return {
        ok: false,
        unsupported: true,
        error: 'open_settings 尚未实现（需要调用客户端设置面板，不属于 Host 能力）',
        state: await buildState(ctx, runtime, sessionId)
      };
    }

    default: {
      return {
        ok: false,
        unsupported: true,
        error: `未知 action: ${action || '(空)'}`,
        state: await buildState(ctx, runtime, sessionId)
      };
    }
  }
}
