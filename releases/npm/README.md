# npm CLI 安装包

| 文件 | 说明 |
|------|------|
| [ice-coder.tgz](./ice-coder.tgz) | `npm pack` 产物，固定文件名；需本机 Node.js 22+ |

构建产物位于仓库根 `ice-coder-<version>.tgz`；执行根目录 `npm run build` 会自动复制到本目录。安装：

```bash
npm install -g ./ice-coder.tgz
iceCoder start
```
