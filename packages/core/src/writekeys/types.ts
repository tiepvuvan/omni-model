/**
 * A registered client of the proxy.
 *
 * Write keys answer "which app is calling", which the auth verifiers cannot:
 * those establish *who the end user is*. Both matter — a leaked build of your
 * iOS app still presents valid user tokens, and revoking the key is how you cut
 * it off without invalidating every user's session.
 *
 * Contains no secret: the key itself is only ever seen at creation.
 */
export interface WriteKey {
  id: string;
  name: string;
  /** Leading characters of the key, for matching a key to this row. */
  prefix: string;
  last4: string;
  /**
   * Client-facing model names this key may request. `null` means no
   * restriction; an empty array means none, which is a way to park a key.
   */
  allowedModels: readonly string[] | null;
  /**
   * Per-client override for prompt/completion capture. `null` inherits the
   * global `logging.content`; `true` and `false` force it either way, so one
   * client can be debugged without logging everyone else's prompts.
   */
  captureContent: boolean | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  expiresAt: number | null;
  /** Set when revoked. Revocation is not deletion, so logs keep their subject. */
  disabledAt: number | null;
}

export interface CreateWriteKeyInput {
  name: string;
  allowedModels?: readonly string[] | null;
  captureContent?: boolean | null;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  expiresAt?: number | null;
}

/** A newly minted key. `secret` is unrecoverable after this. */
export interface CreatedWriteKey {
  writeKey: WriteKey;
  secret: string;
}

export type WriteKeyState = "active" | "revoked" | "expired";

export interface WriteKeyStore {
  readonly type: string;

  /** Mint a key. The plaintext exists only in the return value. */
  create(input: CreateWriteKeyInput): Promise<CreatedWriteKey>;

  /**
   * Look up a presented key, or null when no such key exists.
   *
   * Returns revoked and expired keys too, so the caller can say *why* a
   * credential was refused instead of a flat "unknown key" — the difference
   * between an operator finding the problem in seconds and not.
   */
  authenticate(secret: string): Promise<WriteKey | null>;

  get(id: string): Promise<WriteKey | null>;
  list(): Promise<WriteKey[]>;
  /** Returns whether a key moved from active to revoked. */
  revoke(id: string): Promise<boolean>;
  close?(): Promise<void>;
}

/** Classify a key at a point in time. Order matters: revocation beats expiry. */
export function writeKeyState(key: WriteKey, nowMs: number): WriteKeyState {
  if (key.disabledAt !== null) return "revoked";
  if (key.expiresAt !== null && key.expiresAt <= nowMs) return "expired";
  return "active";
}

/** Resolve whether content should be captured for this request. */
export function shouldCaptureContent(key: WriteKey | null, globalDefault: boolean): boolean {
  return key?.captureContent ?? globalDefault;
}

/** Whether `model` is permitted for this key. */
export function writeKeyAllowsModel(key: WriteKey, model: string): boolean {
  return key.allowedModels === null || key.allowedModels.includes(model);
}
