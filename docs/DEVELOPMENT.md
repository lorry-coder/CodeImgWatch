# ImView 开发者文档

> 本文档面向插件开发者，描述项目架构和开发流程。

---

## 项目结构

```
CodeImgWatch/
├── package.json                 # 插件清单和依赖
├── tsconfig.json               # TypeScript 配置
├── webpack.config.js           # 打包配置
├── src/                        # 扩展源码
│   ├── extension.ts            # 插件入口
│   ├── core/                   # 核心服务
│   │   ├── debugSessionManager.ts   # 调试会话管理
│   │   ├── imageExpressionParser.ts # 表达式解析器
│   │   └── imageOperators.ts        # 图像操作符
│   ├── providers/              # VS Code 提供者
│   │   ├── imageListProvider.ts     # TreeView 提供者
│   │   ├── imageViewerProvider.ts   # Webview 提供者（侧边栏）
│   │   └── imageEditorProvider.ts   # Webview 提供者（编辑器）
│   ├── parsers/                # 图像类型解析器
│   │   ├── baseParser.ts            # 解析器基类
│   │   ├── cvMatParser.ts           # cv::Mat 解析器
│   │   ├── cvMatTemplateParser.ts   # cv::Mat_<T> 解析器
│   │   ├── cvMatxParser.ts          # cv::Matx/Vec 解析器
│   │   ├── legacyParser.ts          # CvMat/IplImage 解析器
│   │   ├── rawArrayParser.ts        # 原始数组解析器
│   │   └── customTypeParser.ts      # 自定义类型解析器
│   ├── types/                  # 类型定义
│   │   ├── imageTypes.ts            # 图像相关类型
│   │   ├── pixelFormats.ts          # 像素格式定义
│   │   ├── messages.ts              # 消息协议
│   │   └── customTypeConfig.ts      # 自定义类型配置
│   └── utils/                  # 工具函数
│       ├── platform.ts              # 平台兼容性
│       ├── colormap.ts              # 颜色映射
│       └── imageTransform.ts        # 图像变换
├── webview/                    # Webview 前端源码
│   ├── viewer.ts               # 主查看器逻辑
│   ├── canvas/                 # Canvas 相关
│   │   ├── imageRenderer.ts    # 图像渲染器
│   │   ├── zoomController.ts   # 缩放控制
│   │   ├── pixelInspector.ts   # 像素检查器
│   │   └── colormap.ts         # 颜色映射
│   └── styles/
│       └── viewer.css          # 样式
├── test/                       # 测试
│   ├── unit/                   # 单元测试
│   └── suite/                  # 集成测试
├── docs/                       # 文档
│   ├── USER_MANUAL.md          # 用户手册
│   └── DEVELOPMENT.md          # 开发文档
└── samples/                    # 示例代码
    └── test_opencv.cpp
```

---

## 开发环境设置

### 1. 安装依赖

```bash
npm install
```

### 2. 编译

```bash
# 开发模式编译
npm run compile

# 生产模式编译
npm run package

# 监视模式
npm run watch
```

### 3. 运行和调试

按 `F5` 启动 Extension Development Host。

### 4. 打包

```bash
npx vsce package --allow-missing-repository
```

---

## 核心模块说明

### DebugSessionManager

管理调试会话和 DAP 通信。

```typescript
// 获取单例
const manager = DebugSessionManager.getInstance();

// 事件监听
manager.onDidStopOnBreakpoint(event => {
    // 断点暂停时触发
});

// DAP 请求
const result = await manager.evaluate('myImage');
const data = await manager.readMemory(address, size);
const vars = await manager.getLocalVariables();
```

### ImageParserRegistry

管理图像类型解析器。

```typescript
// 获取注册表
const registry = ImageParserRegistry.getInstance();

// 注册解析器
registry.register(new MyCustomParser());

// 查找解析器
const parser = registry.findParser('cv::Mat');
```

### 添加新解析器

1. 继承 `BaseImageParser`：

```typescript
export class MyParser extends BaseImageParser {
    readonly name = 'MyType';
    readonly priority = 100;

    canParse(typeName: string): boolean {
        return typeName.includes('MyType');
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        // 解析逻辑
    }
}
```

2. 在 `parsers/index.ts` 中注册：

```typescript
registry.register(new MyParser());
```

### 添加新操作符

在 `imageOperators.ts` 中注册：

```typescript
registerOperator('myop', async (args, context) => {
    // 获取参数
    const imageData = await evaluateArg(args[0], context);
    const param = getNumberArg(args[1]);

    // 处理图像
    const result = transformPixels(imageData, (values) => {
        return values.map(v => /* 变换逻辑 */);
    });

    return { success: true, data: result };
});
```

---

## Extension-Webview 通信协议

### Extension → Webview

```typescript
// 显示图像
{
    command: 'displayImage',
    id: string,
    data: string,        // base64
    width: number,
    height: number,
    channels: number,
    pixelType: string,
    stride: number,
    name: string,
    typeName: string
}

// 显示错误
{
    command: 'showError',
    message: string
}

// 更新选项
{
    command: 'updateOptions',
    options: Partial<DisplayOptions>
}

// 同步视图状态
{
    command: 'syncView',
    state: { zoom, panX, panY }
}

// 设置加载状态
{
    command: 'setLoading',
    loading: boolean
}
```

### Webview → Extension

```typescript
// Webview 就绪
{ command: 'ready' }

// 视图状态变化
{
    command: 'viewStateChanged',
    state: { zoom, panX, panY }
}

// 复制像素值
{
    command: 'copyPixel',
    value: string
}

// 导出图像
{
    command: 'exportImage',
    format: 'png' | 'jpg' | 'bin'
}

// 选项变化
{
    command: 'optionsChanged',
    options: Partial<DisplayOptions>
}

// 刷新请求
{ command: 'refresh' }

// A/B 切换
{ command: 'toggleCompare' }
```

---

## OpenCV 类型解析

### cv::Mat 结构

```
cv::Mat {
    flags: int      // 包含类型信息
    dims: int       // 维度数
    rows: int       // 行数
    cols: int       // 列数
    data: uchar*    // 数据指针
    step: MatStep   // 行步长
}
```

### 类型解码

```typescript
// flags 字段编码
// type = depth | (channels - 1) << 3

const CV_CN_SHIFT = 3;
const CV_DEPTH_MASK = 7;

function decodeCvType(type: number) {
    const depth = type & CV_DEPTH_MASK;
    const channels = ((type >> CV_CN_SHIFT) & 63) + 1;
    return { depth, channels };
}
```

### 像素深度

| 值 | 类型 | 字节数 |
|----|------|--------|
| 0 | CV_8U | 1 |
| 1 | CV_8S | 1 |
| 2 | CV_16U | 2 |
| 3 | CV_16S | 2 |
| 4 | CV_32S | 4 |
| 5 | CV_32F | 4 |
| 6 | CV_64F | 8 |

---

## 测试

### 运行单元测试

```bash
npm run compile-tests
npm test
```

### 测试用 C++ 程序

参考 `samples/test_opencv.cpp`。

---

## 待实现功能

- [ ] PNG/JPG 导出（Canvas 渲染）
- [ ] 缩略图预览
- [ ] ROI 选择
- [ ] 直方图显示
- [ ] 多图像同步视图
- [ ] @file 操作符（从文件加载）
- [ ] @mem 操作符完整实现
- [ ] 更多颜色空间支持（YUV, HSV 等）

---

## 发布流程

1. 更新 `package.json` 版本号
2. 更新 `docs/USER_MANUAL.md` 更新日志
3. 运行测试确保通过
4. 打包：`npx vsce package`
5. 测试 VSIX 安装
6. 发布到 Marketplace（可选）

---

## 相关链接

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
- [OpenCV Documentation](https://docs.opencv.org/)
