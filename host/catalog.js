/**
 * dsh-grid-ui · host/catalog.js
 * 为自定义 UI 提供「可选模型 / 思考强度 / 权限预设」目录，并做进程内缓存。
 *
 * 依赖的 DSH 服务（软获取，缺失时返回空目录而不是抛错）：
 *  - llm.listProviders()                 → [{ id, name, ... }]
 *  - llm.listModels(provider)            → [{ provider, id, name, description?, inputModalities? }]
 *  - llm.resolveModelInfo(provider, m)   → { reasoning: { efforts: [{id,name,description?}], defaultEffort? } }
 *  - permissionPresets.catalog()         → { options: [{value,name,description?}], defaultPreset }
 *
 * 缓存策略：
 *  - 模型 + 权限目录 30 秒 TTL（切换面板时才拉，不必每轮询一次都拉）；
 *  - 单个模型的 efforts 永久缓存（能力是静态的，进程内不会变）。
 */

const CATALOG_TTL_MS = 30_000;

export function createCatalog(ctx) {
  const state = {
    catalog: null,
    catalogAt: 0,
    /** @type {Map<string, Array<{id:string,name:string,description?:string}>>} */
    efforts: new Map()
  };

  function service(name) {
    try {
      return ctx.get(name);
    } catch (error) {
      return undefined;
    }
  }

  /** 列出所有 provider 及其模型（单个 provider 失败不影响其他 provider）。 */
  async function readModels() {
    const llm = service('llm');
    const providers = [];
    const models = [];
    if (!llm || typeof llm.listProviders !== 'function') return { providers, models };

    let raw = [];
    try {
      raw = llm.listProviders();
    } catch (error) {
      raw = [];
    }

    for (const entry of Array.isArray(raw) ? raw : []) {
      const id = typeof entry?.id === 'string' ? entry.id : undefined;
      if (!id) continue;
      providers.push({ id, name: typeof entry.name === 'string' ? entry.name : id });
      if (typeof llm.listModels !== 'function') continue;
      try {
        const list = await llm.listModels(id);
        for (const model of Array.isArray(list) ? list : []) {
          models.push({
            provider: model.provider,
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(model.inputModalities === undefined
              ? {}
              : { inputModalities: model.inputModalities })
          });
        }
      } catch (error) {
        /* 该 provider 的目录不可用：跳过 */
      }
    }

    return { providers, models };
  }

  /** 权限预设目录（来自 permissionPresets.catalog()）。 */
  function readPermissions() {
    const presets = service('permissionPresets');
    if (!presets || typeof presets.catalog !== 'function') {
      return { permissions: [], defaultPreset: null };
    }
    try {
      const catalog = presets.catalog();
      const permissions = (Array.isArray(catalog?.options) ? catalog.options : []).map((option) => ({
        value: option.value,
        name: option.name,
        ...(option.description === undefined ? {} : { description: option.description })
      }));
      return { permissions, defaultPreset: catalog?.defaultPreset ?? null };
    } catch (error) {
      return { permissions: [], defaultPreset: null };
    }
  }

  /**
   * 取完整目录（模型 + 权限），带 TTL 缓存。
   * @param {boolean} [force] 忽略缓存重新读取
   */
  async function catalog(force) {
    const now = Date.now();
    if (!force && state.catalog && now - state.catalogAt < CATALOG_TTL_MS) {
      return { ...state.catalog };
    }
    const { providers, models } = await readModels();
    const { permissions, defaultPreset } = readPermissions();
    state.catalog = { providers, models, permissions, defaultPreset, fetchedAt: now };
    state.catalogAt = now;
    return { ...state.catalog };
  }

  /** 某个模型支持的思考强度列表（永久缓存；失败时返回空数组）。 */
  async function effortsOf(provider, model) {
    if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) return [];
    const key = `${provider}\u0000${model}`;
    if (state.efforts.has(key)) return state.efforts.get(key);

    const llm = service('llm');
    if (!llm || typeof llm.resolveModelInfo !== 'function') {
      state.efforts.set(key, []);
      return [];
    }
    try {
      const info = await llm.resolveModelInfo(provider, model);
      const list = info?.reasoning?.efforts;
      const efforts = (Array.isArray(list) ? list : []).map((effort) => ({
        id: effort.id,
        name: typeof effort.name === 'string' ? effort.name : effort.id
      }));
      state.efforts.set(key, efforts);
      return efforts;
    } catch (error) {
      // 模型能力未知时清缓存，下次再试
      return [];
    }
  }

  return { catalog, effortsOf };
}
