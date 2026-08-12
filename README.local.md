# GC Cutflow 局域网运行说明

双击 `start-cutflow.cmd` 会同时启动团队网页和剪辑工作机，然后打开 `http://localhost:3001`。

## 账号与私有工作区

首次启用前必须创建管理员账号；系统不会提供默认用户名或密码。推荐在受信任的 PowerShell 会话中执行：

```powershell
& "D:\codex\cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" scripts/create-account.mjs --username admin --display-name "管理员" --role admin
```

也可仅在首次启动时临时设置 `CUTFLOW_BOOTSTRAP_USERNAME`、`CUTFLOW_BOOTSTRAP_PASSWORD` 和可选的 `CUTFLOW_BOOTSTRAP_DISPLAY_NAME`；账号创建后应立即从启动环境移除这三个变量。管理员登录后可通过受保护的账号管理 API 创建普通账号。密码仅保存为 scrypt 派生值，登录 Cookie 为 HttpOnly、SameSite=Lax 的随机会话令牌，默认 12 小时有效。

新账号只能看到和操作自己的 Batch、母版、上传、分析、EDL、日志、审核和成片。服务端会对每个资源 ID、下载、媒体预览及所有变更操作重新验证资源归属；前端筛选不是权限边界。新数据工作区为 `storage/users/<账号 UUID>/batches/<Batch UUID>` 和 `storage/users/<账号 UUID>/templates/<模板 UUID>`，交付目录也按账号 UUID 分开。

历史 Batch、模板和无 Batch 记录的 UUID 工作目录不会移动、改名、覆盖或删除。首次成功登录会将缺少归属的记录标记为“历史归档”，并把未登记的历史工作目录写入归档清单；只有管理员可见。管理员可使用归档转交接口将某一历史记录或工作目录明确交给正式账号，原工作目录仍保留在原路径，避免破坏旧任务和交付。

同一 NAS 素材目录（含其父/子目录）在首次挂载到账号后会被该账号保留；其他账号不会在目录列表中看到，也无法通过 API 再次挂载。NAS 原片始终只读。浏览器成片页保留“下载 MP4”；支持 File System Access API 的浏览器还会提供“选择保存位置”，保存路径仅由浏览器处理，永不上传到服务器。

使用顺序：

1. 先在“样片母版”页上传确认过的样片，提前完成结构、色彩、Hook、CVR和卡点拆解。
2. 创建批次时直接选择已就绪母版，再填写整批统一脚本和要求；无需重复上传和等待样片识别。
3. 默认粘贴本次拍摄的 NAS 文件夹路径并点击“检查并扫描”；原片不会上传或复制。
4. 系统在剪辑工作机本地生成低码率分析代理，再根据衣服颜色、印花、号码、版型和正反面关系自动分产品。
5. 在页面确认产品分组和样片母版，整批素材才会进入统一剪辑。
6. 成片进入审核后，可以填写一条整批修改指令继续处理。

NAS 模式下原片始终保留在 NAS，`storage/batches/<批次ID>/proxies` 只保存轻量分析代理，最终剪辑会回链 NAS 原片。浏览器上传仍可作为备用方式。

任务状态保存在 `data/batches.json`。任务处理错误时，可在任务卡片或详情区点击“取消任务”，正在运行的识别、代理生成或剪辑会被中断，已有文件会保留。

审核成片会自动复制到 `E:\尔尔本地\素材\基督\自动剪辑\成片\<批次名称_批次ID>`，不同批次使用独立子文件夹，避免文件重名。
