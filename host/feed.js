/**
 * dsh-grid-ui · host/feed.js
 * ----------------------------------------------------------------------------
 * 「AI 输出监看」的 Host 半。
 *
 * 为什么要单独做一层：窗口是沙箱 iframe，它没法直接订阅 DSH 的会话事件；
 * 而 Host 刚好在事件总线上（`ctx.on('session/event', (session, event) => …)`，
 * 参考已装的 dsh-whale-widget 的用法）。于是 Host 把事件流缩成一份「动态」：
 *
 *   user / assistant / tool / tool-result / turn / error
 *
 * 浏览器侧只按 seq 增量拉取（GET /dsh-grid-ui/feed?since=N），因此：
 *   - 不会把整段历史塞进每 700ms 的 /state 轮询里；
 *   - 刷新页面后仍能看到本次会话已经发生的事（Host 侧内存里还在）。
 *
 * 注意：这里只保留「最近 N 条、每会话一份」，不做持久化——它是实时的监看面板，
 * 真正的历史请用 read_history（sessionController.page）。
 */

/** 每个会话最多保留多少条（超出丢弃最旧的） */
const MAX_ITEMS = 120;
/** 单个会话最多保留多久（毫秒）；超时后整桶清空，避免长跑内存增长 */
const MAX_IDLE_MS = 6 * 60 * 60 * 1000;
/** 同时保留多少个会话的桶 */
const MAX_BUCKETS = 12;
/** 单条文本上限（字符）：足够展示，又不至于把轮询撑爆 */
const MAX_TEXT = 6000;
/** 工具输入/结果预览上限 */
const MAX_PREVIEW = 700;

/** 把 message.content（块数组）摊平成可读文本 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(`〔思考〕${block.text}`);
    else if (block.type === 'image') parts.push('〔图片〕');
    else if (block.type === 'document') parts.push('〔附件〕');
  }
  return parts.join('\n').trim();
}

/** 从一条 assistant 消息里挑出工具调用（名字 + 参数摘要） */
function toolCallsOf(message) {
  const content = message && message.content;
  if (!Array.isArray(content)) return [];
  const calls = [];
  for (const block of content) {
    if (!block || block.type !== 'tool-call') continue;
    let args = '';
    const input = block.input ?? block.arguments;
    if (typeof input === 'string') args = input;
    else if (input && typeof input === 'object') {
      try {
        args = JSON.stringify(input);
      } catch (error) {
        args = '';
      }
    }
    calls.push({
      name: typeof block.name === 'string' ? block.name : 'tool',
      args: args.length > MAX_PREVIEW ? `${args.slice(0, MAX_PREVIEW)}…` : args
    });
  }
  return calls;
}

/** 截断文本 */
function clip(text, limit = MAX_TEXT) {
  if (typeof text !== 'string') return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 创建「动态」收集器。
 * @returns {{ ingest: Function, snapshot: Function, setBusy: Function, clear: Function, size: Function }}
 */
export function createFeed() {
  /** @type {Map<string, {seq:number, items:object[], busy:boolean, updatedAt:number}>} */
  const buckets = new Map();

  function bucket(sessionId) {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : 'default';
    let state = buckets.get(id);
    if (!state) {
      state = { seq: 0, items: [], busy: false, updatedAt: Date.now() };
      buckets.set(id, state);
      pruneBuckets();
    }
    return state;
  }

  /** 桶太多或太旧就清掉最久没动静的，防止长期运行内存增长 */
  function pruneBuckets() {
    const now = Date.now();
    for (const [id, state] of buckets) {
      if (now - state.updatedAt > MAX_IDLE_MS) buckets.delete(id);
    }
    if (buckets.size <= MAX_BUCKETS) return;
    const sorted = [...buckets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [id] of sorted.slice(0, buckets.size - MAX_BUCKETS)) buckets.delete(id);
  }

  function push(state, item) {
    state.seq += 1;
    state.updatedAt = Date.now();
    state.items.push({ seq: state.seq, at: new Date().toISOString(), ...item });
    if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS);
    return state.items[state.items.length - 1];
  }

  /**
   * 吃一条会话事件。
   * @param {{ id?: string }} session
   * @param {{ type?: string, data?: object }} event
   */
  function ingest(session, event) {
    const type = event && event.type;
    const data = (event && event.data) || {};
    if (typeof type !== 'string') return;
    const state = bucket(session && session.id);

    switch (type) {
      case 'user/message': {
        const text = clip(contentToText(data.message && data.message.content));
        push(state, { kind: 'user', text: text || '〔消息〕' });
        state.busy = true;
        return;
      }
      case 'assistant/message': {
        const message = data.message || {};
        const text = clip(contentToText(message.content));
        if (text) push(state, { kind: 'assistant', text, turn: data.turn, step: data.step });
        for (const call of toolCallsOf(message)) {
          push(state, { kind: 'tool', text: call.args, tool: call.name, turn: data.turn, step: data.step });
        }
        return;
      }
      case 'tool/result': {
        const message = data.message || {};
        const text = clip(contentToText(message.content), MAX_PREVIEW * 3);
        push(state, {
          kind: 'tool-result',
          text: text || '〔无输出〕',
          tool: typeof data.name === 'string' ? data.name : undefined,
          isError: data.isError === true || data.ok === false
        });
        return;
      }
      case 'turn/start': {
        state.busy = true;
        push(state, { kind: 'turn', text: '开始', phase: 'start', turn: data.turn });
        return;
      }
      case 'turn/end': {
        state.busy = false;
        const reason = typeof data.reason === 'string' ? data.reason : typeof data.stopReason === 'string' ? data.stopReason : '';
        push(state, { kind: 'turn', text: reason || '结束', phase: 'end', turn: data.turn });
        return;
      }
      case 'step/start':
        state.busy = true;
        return;
      case 'step/end': {
        const usage = data.usage;
        if (usage && typeof usage === 'object') {
          const tokens =
            (Number(usage.inputTokens) || 0) +
            (Number(usage.cacheReadTokens) || 0) +
            (Number(usage.outputTokens) || 0) +
            (Number(usage.reasoningTokens) || 0);
          if (tokens > 0) push(state, { kind: 'step', text: `本步 ${tokens} tok`, step: data.step });
        }
        return;
      }
      case 'approval/asked': {
        push(state, { kind: 'approval', text: '等待你批准一个操作' });
        return;
      }
      case 'llm/retry': {
        push(state, { kind: 'error', text: '模型调用重试中…' });
        return;
      }
      case 'goal/change': {
        const goal = data.goal && typeof data.goal === 'object' ? data.goal : null;
        if (goal && typeof goal.objective === 'string') {
          push(state, { kind: 'goal', text: clip(goal.objective, MAX_PREVIEW) });
        }
        return;
      }
      default:
        return;
    }
  }

  /** 供 agent/status 之类的「只有忙碌度」的事件使用 */
  function setBusy(sessionId, busy) {
    const state = bucket(sessionId);
    state.busy = busy === true;
    state.updatedAt = Date.now();
  }

  /**
   * 增量快照。
   * @param {string} [sessionId]
   * @param {number} [since] 只返回 seq > since 的条目
   */
  function snapshot(sessionId, since) {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : 'default';
    const state = buckets.get(id);
    const from = Number.isFinite(since) && since > 0 ? since : 0;
    if (!state) return { sessionId: id === 'default' ? null : id, seq: 0, busy: false, items: [] };
    const items = from > 0 ? state.items.filter((item) => item.seq > from) : state.items.slice(-60);
    return {
      sessionId: id === 'default' ? null : id,
      seq: state.seq,
      busy: state.busy,
      items
    };
  }

  function clear() {
    buckets.clear();
  }

  function size() {
    return buckets.size;
  }

  return { ingest, setBusy, snapshot, clear, size };
}
