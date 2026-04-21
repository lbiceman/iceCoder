---
inclusion: auto
---

# 知识库规则（自动加载）

## 查询优先级
1. 先搜项目代码
2. 再搜 MCP 知识库（search_nodes）
3. 最后问用户

## 文档解析自动选择
遇到需求文档时，根据格式自动选择解析方式：
- `.xmind` → 知识库搜索 "XMind解析工具-Node" 获取完整解析脚本
- `.pptx` → 知识库搜索 "PPTX解析工具-Node" 获取完整解析脚本
- `.docx` → 使用 mammoth 或 officeparser
- `.pdf` → 使用 pdf-parse
- `.md/.txt` → 直接读取
- `.html` → cheerio 解析
- URL → 使用 browsermcp 导航 + snapshot，或 fetch_url 工具

## 防回归原则
- 先理解再动手：分析受影响的文件和调用链
- 新增优于修改：优先新建文件/类/函数
- 接口兼容：不修改已有 public 方法签名
- 数据兼容：新增字段必须可选并提供默认值
- 先跑老测试：改动前后都要跑测试确认零回归

## 错误处理
- 底层抛具体技术错误，中间层转业务错误，顶层统一处理
- try-catch 只包裹最小代码块，禁止空 catch
- 可恢复错误重试，不可恢复错误终止提示，非关键功能降级

## Git 提交
- 格式：`<type>: <描述>`（feat/fix/refactor/style/docs/test/chore）
- 单次提交只做一件事
- 提交前：lint → 测试 → diff → 确认无调试代码

## TypeScript 规范
- 用类型守卫替代 as 强转
- any 用完立即转回具体类型
- 优先 const 对象 + as const 替代 enum
- readonly T[] 防意外修改

## 知识库记录规则
- 及时记录且通用化：禁止写入项目特定内容，提炼为跨项目通用经验
- 每次修改 steering 规则后同步更新知识库对应实体
