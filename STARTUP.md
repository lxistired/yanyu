# 启动与重现

## 环境与安装

- Linux x86_64 是当前验证平台；macOS、Windows、移动设备未验收。
- Node `>=24.19.0 <25`，npm `>=11 <12`；锁定依赖在 `package-lock.json`。不要升级依赖或更换锁文件以掩盖安装问题。
- PDF 提取/渲染需要 `/usr/bin/pdfinfo`、`pdftotext`、`pdftoppm` 和 `/usr/bin/prlimit`。不移除资源限制。
- 基础应用与当前选定前端测试不要求模型/API key。可选合成 Python 测试需 Python 3；实际 ASR 另见下节。

在本目录运行：

```sh
node verify-release-pins.mjs --strict  # 安装/启动之前的干净包检查
npm ci --ignore-scripts --no-audit --no-fund
npm run verify:pins                   # 安装后只校验列入文件，不扫描 node_modules
npm run typecheck
npm test                             # 限定当前核心 UI；准确集合在 release config
npm run test:release-pins
npm run build
```

不能使用 `npm ci --omit=dev`：当前运行期需要的包也登记于 devDependencies。若本机默认 npm 缓存不可写，可为**当前命令**指定自己可写的新缓存目录，不改 HOME/全局配置、不改 registry/完整性校验。离线安装仅在已有所有锁定、匹配平台的可信缓存时成立。

`--strict` 用于尚无安装/生成输出的干净暂存区，会拒绝所有未列入的文件；安装或测试后出现 node_modules、日志、缓存时不应重新称为“干净公开包”。普通 `verify:pins` 只验证清单文件。重建若改变已列入 `dist` 哈希，必须先复核源码/构建，再由发布负责人建立新清单，不能自动刷新来把失败变通过。

## 常规持久启动

先选择全新私有目录，例如把下面的路径改成你自己新建的路径：

```sh
env -u JP_PRIVATE_DEMO -u JP_PRIVATE_DB_PATH -u JP_PRIVATE_DB_SHA256 \
  YANYU_DATA_DIR="$HOME/.local/share/yanyu-first-run" npm start
```

- 打开打印的 READY 地址；默认随机端口，可显式设 `YANYU_PORT`，始终只监听 127.0.0.1。
- `npm start` 准备当前后端 runtime 并读取已有 dist，不自动执行 Vite build。
- 输入 `quit`、Ctrl-C 或 SIGTERM；stdin EOF 不等于退出。仅对自己启动的进程正常停止，不按旧日志 PID 杀进程。
- 常规退出保留数据。若未设置目录，默认 `${XDG_DATA_HOME:-$HOME/.local/share}/yanyu-inventory-schedules`。同一数据目录只运行一个 launcher。
- `npm run start:demo` 使用可丢弃目录，拒绝已有 `YANYU_DATA_DIR`；正常结束删除其受控 payload，所有权标记和 runtime 可能保留。SIGKILL 不保证清理。
- 原始文档、转写历史、录音/识别临时文件、SQLite 与事件日志都属私人数据，不可提交。停止后备份；回收站不释放总体存储配额，没有通用永久擦除入口。

本轮已有同一执行环境内的真实 HTTP 首页/JS/CSS 哈希验证；云浏览器跨工具访问仍连接失败，根因未确认。不能为此开放公网或绕开启动安全边界。业务链路/真实浏览器需要可访问同版构建的另一次授权验收。

## 测试入口的真实范围

- `npm test` / `npm run test:ui-current`：明确选择的 12 个当前 UI/transport 套件；对应公开去敏源码已在现有锁定依赖下按草案脚本运行通过。独立干净安装仍未重做，详见 ACCEPTANCE。
- `npm run test:legacy-full`：原通配全部前端套件，未建立本次全量通过。至少 initial-upload-idempotency、plan-collection-real-roundtrip、plan-linked-session-real-roundtrip、plan-document-real-roundtrip 依赖缺失的 repo 根 `prepared-runtime`。
- `npm run test:integration:legacy`：保留的旧综合 runner，也不能直接当本次受支持的全量认证命令。它可能启动本机 HTTP、生成 SQLite/日志，并触发上述未满足前提。
- 现有单项后端脚本只可使用全新合成目录、清空私有 provider 环境。原生私有数据与需要额外音频的旧脚本未纳入最小发布集合；没有“补齐私人音频”的步骤。

标准 launcher 的 prepare 把 runtime 输出到它自己受控的临时目录，**不会**创建上述旧测试要求的 repo 根 prepared-runtime。仅执行 npm start 不能修复旧测试前提；不要复制历史 runtime/symlink。

## 可选本地 ASR

实际识别另需 Python 3.12、`requirements.lock` 所列包、`/usr/bin/ffmpeg` 与用户自己已有且获准使用的本地 CTranslate2 模型快照。设置 `YANYU_PYTHON`、`YANYU_MODEL_DIR` 指向它们；默认 Python 为 `.venv/bin/python`，默认模型为应用内 `models/faster-whisper-small`。Python 锁为版本锁，不是跨平台 wheel 哈希清单。

本包不含 Python 环境、音频或模型，不自动下载权重，不提供真实 ASR 准确率证明。任务中断后须显式继续；待识别文件默认固定 24 小时过期，恢复会校验任务身份/设置/检查点。记录与转写历史的保留是另一回事，不能把临时文件清理当作彻底删除所有内容。
