/**
 * dsh-grid-ui · host/sanitize.js
 * AI 生成 HTML 的「基础校验」。
 *
 * 需求原文：「所有 AI 生成的 HTML 必须经过基础校验：禁止外链 script src 指向 http/https
 * 的资源，禁止 document.cookie、localStorage 等敏感 API 调用。」
 *
 * 策略：**拒绝**而不是静默改写。静默改写会让 AI 以为页面正常，实际行为不符；
 * 直接报错能让 AI 立刻修正 HTML。第一层真正的隔离仍然是 iframe 的
 * sandbox="allow-scripts allow-forms"（无 allow-same-origin），这条校验只是纵深防御。
 */

import { MAX_HTML_BYTES } from './windows.js';

/** 外链脚本：<script src="http(s)://..."> */
const EXTERNAL_SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["']?\s*https?:\/\//i;

/** 禁用敏感 Web API（按词边界匹配，避免误伤普通文案） */
const FORBIDDEN_APIS = [
  { pattern: /\bdocument\s*\.\s*cookie\b/i, label: 'document.cookie' },
  { pattern: /\blocalStorage\b/i, label: 'localStorage' },
  { pattern: /\bsessionStorage\b/i, label: 'sessionStorage' },
  { pattern: /\bindexedDB\b/i, label: 'indexedDB' },
  { pattern: /\bdocument\s*\.\s*domain\b/i, label: 'document.domain' },
  { pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/i, label: 'document.write()' }
];

/** 会改变文档基地址或整页跳转的标签 */
const FORBIDDEN_TAGS = [
  { pattern: /<base\b/i, label: '<base> 标签' },
  { pattern: /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, label: '<meta http-equiv="refresh">' }
];

/**
 * 校验一段 AI 生成的 HTML。
 * @param {unknown} html
 * @returns {{ ok: true, html: string } | { ok: false, error: string }}
 */
export function sanitizeHtml(html) {
  if (typeof html !== 'string') {
    return { ok: false, error: 'html 必须是字符串' };
  }
  if (html.trim() === '') {
    return { ok: false, error: 'html 不能为空' };
  }
  // 注意：这里**不** trim 内容。首尾空白对渲染有影响（例如 <pre> 或依赖 :first-child 的
  // 选择器），而且写盘后要能对回原文，方便故障排查。
  const text = html;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_HTML_BYTES) {
    return {
      ok: false,
      error: `html 太大（${Math.round(bytes / 1024)} KB），上限为 ${MAX_HTML_BYTES / 1024} KB`
    };
  }

  if (EXTERNAL_SCRIPT.test(text)) {
    return {
      ok: false,
      error: '禁止使用外部 <script src="http(s)://...">。请把所有脚本内联到页面里，不要引用 CDN。'
    };
  }

  for (const rule of FORBIDDEN_APIS) {
    if (rule.pattern.test(text)) {
      return { ok: false, error: `禁止调用敏感 API：${rule.label}` };
    }
  }

  for (const rule of FORBIDDEN_TAGS) {
    if (rule.pattern.test(text)) {
      return { ok: false, error: `禁止使用：${rule.label}` };
    }
  }

  return { ok: true, html: text };
}
