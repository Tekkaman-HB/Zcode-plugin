/**
 * [INPUT]: 依赖 node:fs/crypto/os，读取 ~/.zcode/v2/credentials.json
 * [OUTPUT]: 对外提供 decryptCredentials / getProviderApiKey（凭据解密与 provider→apiKey 映射）
 * [POS]: 凭据层——与桌面端同构的 enc:v1 解密，serverManager 应答 requestProviderRuntimeHeaders 时消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 格式（逆向自桌面端 app.asar）：
 *   enc:v1:<b64(iv12)>.<b64(tag16)>.<b64(ciphertext)>
 *   key = sha256(secret)，secret = $ZCODE_CREDENTIAL_SECRET || zcode-credential-fallback:<platform>:<homedir>:<username>
 * 安全约束：解密结果仅用于应答 CLI 的认证反向请求，严禁日志/上报。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const ENC_PREFIX = 'enc:v1:';

function credentialSecret(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (fromEnv) return fromEnv;
  let username = 'unknown';
  try {
    username = os.userInfo().username;
  } catch {
    /* 保持 unknown */
  }
  return `zcode-credential-fallback:${process.platform}:${os.homedir()}:${username}`;
}

function decryptValue(value: string, key: Buffer): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(ENC_PREFIX)) return value; // 明文值直接返回
  const parts = value.slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ct = Buffer.from(parts[2], 'base64');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(ct), cipher.final()]).toString('utf8');
  } catch {
    return null; // 密钥不匹配或密文损坏
  }
}

export interface DecryptedCredentials {
  /** 解密后的键值表（值可能为 null=解密失败） */
  values: Map<string, string | null>;
  /** 是否有任何解密失败（提示密钥环境不一致） */
  anyDecryptFailure: boolean;
}

export function decryptCredentials(credentialsPath: string, env: NodeJS.ProcessEnv = process.env): DecryptedCredentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(credentialsPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const key = crypto.createHash('sha256').update(credentialSecret(env)).digest();
  const values = new Map<string, string | null>();
  let anyDecryptFailure = false;
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') continue;
    const dec = decryptValue(v, key);
    if (dec === null) anyDecryptFailure = true;
    values.set(k, dec);
  }
  return { values, anyDecryptFailure };
}

/**
 * providerId → 对应 coding-plan 的 API key。
 * providerId 形如 account:bigmodel-individual-coding-plan，
 * 凭据键形如 account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:<uid>:api-key。
 */
export function getProviderApiKey(creds: DecryptedCredentials, providerId: string): string | null {
  const planToken = providerId.startsWith('account:') ? providerId.slice('account:'.length) : providerId;
  const prefix = `account-provider:coding-plan:account:${planToken}:account:`;
  for (const [k, v] of creds.values) {
    if (k.startsWith(prefix) && k.endsWith(':api-key') && typeof v === 'string' && v.length > 0) {
      return v;
    }
  }
  return null;
}
