/**
 * 清空数据库：抹掉**全部业务数据**，只按 `.env` 重建平台管理员账号
 *
 * 用法：
 *   npx tsx scripts/wipe-data.ts                      # 干跑（默认，不写库）：只打印每张表的待删行数
 *   npx tsx scripts/wipe-data.ts --yes                # 真正执行；执行前自动备份 SQLite 文件
 *   npx tsx scripts/wipe-data.ts --yes --no-backup    # 真正执行，跳过备份
 *   npx tsx scripts/wipe-data.ts --yes --no-reseed    # 真正执行，且不重建引擎语种清单
 *
 * 提示：本地跑时会刷出大量 `prisma:query ...` 日志，加 `NODE_ENV=production` 前缀即可安静：
 *   NODE_ENV=production DATABASE_URL="file:./dev.db" npx tsx scripts/wipe-data.ts --yes
 *（生产容器内 NODE_ENV 已是 production，无需额外处理）
 *
 * 行为：
 *   1) 表清单从 `sqlite_master` **动态枚举**（以后新增表不会被漏掉），
 *      排除 `_prisma_migrations`（迁移记录）与 `sqlite_*`（SQLite 内部表）；
 *   2) 会话内先 `PRAGMA foreign_keys = OFF`，再逐表 `DELETE FROM`，
 *      因此**不依赖删除顺序**（父子表先后都行），最后恢复 `foreign_keys = ON`；
 *      同时重置 `sqlite_sequence`（清掉自增计数）；
 *   3) 清空后调用 `authService.ensurePlatformAdmin()`，用 `.env` 的
 *      `PLATFORM_EMAIL` + `PLATFORM_INITIAL_PASSWORD` **重建**平台管理员；
 *   4) 再调 `ensureLanguageSupport()` 重建引擎语种清单（代码内置的参照数据，
 *      与全新部署后的状态一致；不需要时加 `--no-reseed`）。
 *
 * ⚠️ 两件事必须知道：
 *   - **所有既有后台账号都会被删除**，包括库里原有的其他 PLATFORM 账号
 *     （最终 `admin_accounts` 只剩 1 条 = `.env` 里那个）；
 *   - **平台管理员密码会被重置为 `.env` 的 `PLATFORM_INITIAL_PASSWORD`**，
 *     即使原来改过密码也一样。
 *
 * 抹除后用户后台（`/api/supervisor/*`）**无可用账号**：主管账号随团队一并删除，
 * 需重新走「平台管理员登录 → 创建团队（接口会返回主管初始密码）」。
 *
 * 生产环境（服务器 `/opt/matreko`，compose 容器名 `matreko`，库 `/data/prod.db`）：
 *   cd /opt/matreko
 *   cp data/prod.db "data/prod.db.bak-$(date +%Y%m%d%H%M)"     # 手工再保一份（脚本备份落在容器内 /data）
 *   docker exec matreko npx tsx scripts/wipe-data.ts           # 先干跑，核对表清单与行数
 *   docker exec matreko npx tsx scripts/wipe-data.ts --yes     # 执行
 */
import { copyFileSync, existsSync } from 'node:fs';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { authService } from '@/services/auth.service';
import { ensureLanguageSupport } from '@/services/translation/langSupport';

const CONFIRMED = process.argv.includes('--yes');
const NO_BACKUP = process.argv.includes('--no-backup');
const NO_RESEED = process.argv.includes('--no-reseed');

/** 需要跳过的内部表：Prisma 迁移记录 + SQLite 内部表 */
const SKIP_TABLES = new Set(['_prisma_migrations']);

/** 当前数据库文件绝对路径（`:memory:` 或非 SQLite 返回 null） */
async function resolveDbFile(): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; file: string }>>(
    'PRAGMA database_list',
  );
  const main = rows.find((r) => r.name === 'main');
  return main?.file ? main.file : null;
}

/** 动态枚举业务表（排除内部表） */
async function listTables(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return rows.map((r) => r.name).filter((n) => !SKIP_TABLES.has(n) && !n.startsWith('sqlite_'));
}

/** 单表行数（Prisma 对 SQLite 的 COUNT(*) 返回 BigInt，必须转 Number 再序列化） */
async function countRows(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT COUNT(*) AS c FROM "${table}"`,
  );
  return Number(rows[0]?.c ?? 0);
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const dbFile = await resolveDbFile();
  const tables = await listTables();

  console.log('═══ 目标数据库 ═══');
  console.log(`  DATABASE_URL = ${env.databaseUrl}`);
  console.log(`  实际文件     = ${dbFile ?? '(非文件库，可能是 :memory:)'}`);
  console.log(`  平台管理员   = ${env.platformEmail}（密码将被重置为 PLATFORM_INITIAL_PASSWORD）`);
  console.log(`  待清空表     = ${tables.length} 张`);

  // ── 1. 逐表统计（干跑也会走这一步） ──
  console.log('\n═══ 待删除行数 ═══');
  let total = 0;
  for (const t of tables) {
    const n = await countRows(t);
    total += n;
    console.log(`  - ${t.padEnd(26, ' ')} ${String(n).padStart(7, ' ')} 条`);
  }
  console.log(`  合计 ${total} 条`);

  // ── 2. 干跑：到此为止 ──
  if (!CONFIRMED) {
    console.log('\n⚠️ 这是**干跑**，未写库。确认无误后加 --yes 真正执行：');
    console.log('     npx tsx scripts/wipe-data.ts --yes');
    console.log(
      '   （执行时会先备份库文件，再清空上表，最后重建平台管理员' +
        (NO_RESEED ? '' : '与引擎语种清单') +
        '）',
    );
    return;
  }

  // ── 3. 备份 ──
  if (NO_BACKUP) {
    console.log('\n(--no-backup：跳过备份)');
  } else if (dbFile && existsSync(dbFile)) {
    const bak = `${dbFile}.bak-${timestamp()}`;
    copyFileSync(dbFile, bak);
    console.log(`\n已备份：${bak}`);
  } else {
    console.log('\n⚠️ 未找到数据库文件（非文件库），跳过备份');
  }

  // ── 4. 清空 ──
  console.log('\n═══ 清空中 ═══');
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
  try {
    for (const t of tables) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
    }
    // 自增计数（存在才重置）
    const seq = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
    );
    if (seq.length > 0) {
      await prisma.$executeRawUnsafe('DELETE FROM sqlite_sequence');
    }
    console.log(`  已清空 ${tables.length} 张表${seq.length > 0 ? '（含 sqlite_sequence 自增计数）' : ''}`);
  } finally {
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON');
  }

  // ── 5. 校验：业务表必须全 0 ──
  const residual: Array<[string, number]> = [];
  for (const t of tables) {
    const n = await countRows(t);
    if (n !== 0) residual.push([t, n]);
  }
  if (residual.length > 0) {
    console.error('\n❌ 清空后仍有残留（已中止，未重建管理员）：');
    for (const [t, n] of residual) console.error(`   - ${t} = ${n}`);
    process.exitCode = 1;
    return;
  }
  console.log('  业务表残留检查：全部为 0 ✅');

  // ── 6. 按 .env 重建平台管理员 ──
  console.log('\n═══ 重建平台管理员（来自 .env） ═══');
  await authService.ensurePlatformAdmin();

  // ── 7. 重建引擎语种清单（代码内置参照数据，与全新部署后的状态一致） ──
  let langRows = 0;
  if (NO_RESEED) {
    console.log('\n(--no-reseed：未重建引擎语种清单，翻译会用到语种校验时可能报不支持)');
  } else {
    console.log('\n═══ 重建引擎语种清单 ═══');
    const seeded = await ensureLanguageSupport();
    langRows = await countRows('engine_language_supports');
    if (seeded === 0 && langRows === 0) {
      console.warn('⚠️ 语种清单仍为空，请检查 DEFAULT_LANGUAGE_SET 配置');
    } else {
      console.log(`  已写入 ${seeded} 条默认语种（当前库中 ${langRows} 条）`);
    }
  }

  const admins = await prisma.adminAccount.findMany({
    select: { id: true, email: true, role: true, status: true, teamId: true },
  });
  console.log(`\nadmin_accounts 现有 ${admins.length} 条：`);
  for (const a of admins) {
    console.log(`  - ${a.email}  role=${a.role}  status=${a.status}  teamId=${a.teamId ?? '-'}`);
  }
  if (admins.length !== 1 || admins[0].email !== env.platformEmail) {
    console.error('\n❌ 期望只保留 1 条平台管理员且邮箱等于 .env 的 PLATFORM_EMAIL，实际不符');
    process.exitCode = 1;
    return;
  }

  const auditRows = await countRows('audit_logs');
  console.log(
    `\n✅ 清空完成：\n` +
      `   业务表全为 0（audit_logs 有 ${auditRows} 条初始化审计记录）\n` +
      `   仅保留平台管理员 ${admins[0].email}（密码 = .env 的 PLATFORM_INITIAL_PASSWORD）\n` +
      `   引擎语种清单 ${langRows} 条\n` +
      '   提醒：用户后台暂不可登录，需用该账号「创建团队」拿到主管初始密码。',
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('\n清空失败：', e);
    await prisma.$disconnect();
    process.exit(1);
  });
