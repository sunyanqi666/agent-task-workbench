import { loadConfig } from './config';
import { openDatabase } from './db';
import { buildServer } from './app';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.modelProvider && !config.modelApiKey) {
    console.warn(
      '[config] 已配置 MODEL_PROVIDER 但未设置 MODEL_API_KEY：真实任务将无法执行；演示模式不受影响',
    );
  }
  const db = openDatabase(config.databaseUrl);
  const app = await buildServer(db, config);
  // 仅监听本机；容器部署（P4）再按需放开
  await app.listen({ port: config.apiPort, host: '127.0.0.1' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
