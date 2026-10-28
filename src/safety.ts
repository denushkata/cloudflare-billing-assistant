// Rules for any text a person or file supplies (analyst notes and names, CSV fields) and
// for text the model returns. Everything is rendered as plain text, so the goal here is
// not markup escaping but keeping links, look-alike tricks and oversized input out of
// the audit trail and the prompt.

/** Bidi overrides (Trojan Source), zero-width characters, BOM, and control characters other than tab/newline. */
const HIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

const LINK_PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\//i, // any scheme://
  /\b(?:javascript|data|vbscript|file|mailto|tel|sms):/i,
  /\bwww\./i,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/\S*/i, // domain.tld/path
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|dev|app|ai|xyz|info|biz|me|ly|link|click|top|site|online|live|shop|ru|cn|tk|gq|zip|mov)\b/i,
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, // email address
  /<\/?[a-z][^>]*>/i, // HTML tags
  /\[[^\]]*\]\([^)]*\)/, // markdown link
];

export function containsLink(text: string): boolean {
  return LINK_PATTERNS.some((p) => p.test(text));
}

export function hasHiddenChars(text: string): boolean {
  return HIDDEN_CHARS.test(text);
}

/**
 * Validate free text from a person or file. Returns the normalized text, or throws with a
 * message safe to show to the user. Links are refused outright: reference a ticket or
 * memo ID instead, so no one can plant a phishing link in the audit trail or the prompt.
 */
export function safeText(raw: unknown, field: string, { max, required = false }: { max: number; required?: boolean }): string {
  if (raw != null && typeof raw !== "string") throw new SafetyError(`${field} must be text`);
  const text = (raw ?? "").normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (required && !text) throw new SafetyError(`${field} is required`);
  if (text.length > max) throw new SafetyError(`${field} is longer than ${max} characters`);
  if (hasHiddenChars(text)) throw new SafetyError(`${field} contains hidden or control characters`);
  if (containsLink(text)) {
    throw new SafetyError(`${field} cannot contain links, email addresses or HTML; reference a ticket or memo ID instead`);
  }
  return text;
}

/** IDs from CSV files and URLs: letters, digits, dot, underscore and hyphen only. They become storage keys. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function safeId(raw: string, field: string): string {
  const id = raw.trim();
  if (!ID_PATTERN.test(id)) {
    // IDs are ASCII, so any other character is shown as an escape: a Cyrillic "С01" must not read as C01.
    const shown = id.slice(0, 40).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    throw new SafetyError(`${field} "${shown}" must be 1-64 letters, digits, ".", "_" or "-"`);
  }
  return id;
}

/** Analyst names: a person's name or handle, nothing that could pass for a link or address. */
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}0-9 .'_-]{0,99}$/u;

export function safeAnalystName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.normalize("NFC").trim() : "";
  if (!name) throw new SafetyError("analyst name is required (up to 100 characters)");
  if (!NAME_PATTERN.test(name) || containsLink(name)) {
    throw new SafetyError("analyst name may contain letters, digits, spaces, and . ' _ - only (up to 100 characters)");
  }
  return name;
}

/**
 * Make a message that quotes untrusted input safe to list: hidden and control characters become
 * visible escapes (so a right-to-left override cannot reorder what the reviewer reads), and length is capped.
 */
export function visibleText(text: string, max = 200): string {
  const shown = text.replace(new RegExp(HIDDEN_CHARS.source, "g"), (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return shown.length > max ? `${shown.slice(0, max - 1)}…` : shown;
}

/** A refusal whose message is safe to show to the user. */
export class SafetyError extends Error {}
