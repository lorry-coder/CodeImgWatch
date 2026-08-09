# ImView for VS Code 用户操作手册

> 版本: 0.1.0
> 最后更新: 2026-03-14

---

## 目录

- [1. 简介](#1-简介)
- [2. 安装与配置](#2-安装与配置)
  - [2.1 系统要求](#21-系统要求)
  - [2.2 安装插件](#22-安装插件)
  - [2.3 调试器配置](#23-调试器配置)
- [3. 快速入门](#3-快速入门)
- [4. 界面说明](#4-界面说明)
  - [4.1 ImView 列表面板](#41-image-watch-列表面板)
  - [4.2 Image Viewer 查看器面板](#42-image-viewer-查看器面板)
  - [4.3 独立编辑器标签页](#43-独立编辑器标签页)
- [5. 功能详解](#5-功能详解)
  - [5.1 自动检测图像变量 (Locals 模式)](#51-自动检测图像变量-locals-模式)
  - [5.2 手动添加监视表达式 (Watch 模式)](#52-手动添加监视表达式-watch-模式)
  - [5.3 图像查看与交互](#53-图像查看与交互)
  - [5.4 像素值检查](#54-像素值检查)
  - [5.5 显示选项](#55-显示选项)
  - [5.6 图像操作符](#56-图像操作符)
  - [5.7 图像导出](#57-图像导出)
  - [5.8 A/B 对比功能](#58-ab-对比功能)
- [6. 支持的图像类型](#6-支持的图像类型)
  - [6.1 OpenCV 类型](#61-opencv-类型)
  - [6.2 自定义类型配置](#62-自定义类型配置)
- [7. 配置选项](#7-配置选项)
- [8. 快捷键参考](#8-快捷键参考)
- [9. 故障排除](#9-故障排除)
- [10. 更新日志](#10-更新日志)

---

## 1. 简介

**ImView for VS Code** 是一个用于 C/C++ 和 Python 调试的图像可视化插件，类似于 Visual Studio 的 ImView 功能。它允许开发者在调试过程中实时查看和分析图像数据，特别适用于 OpenCV 图像处理和深度学习开发。

### 主要特性

- ✅ 实时查看调试中的图像变量
- ✅ 支持 C++ OpenCV 全系列类型 (`cv::Mat`, `cv::Mat_<T>`, `cv::Matx`, `CvMat`, `IplImage`)
- ✅ 支持 Python 图像类型 (`numpy.ndarray`, `PIL.Image`, `torch.Tensor`)
- ✅ 支持多种调试器 (GDB, LLDB, MSVC, debugpy)
- ✅ 交互式图像查看器（缩放、平移、像素检查）
- ✅ 图像操作符（通道提取、阈值、差异对比等）
- ✅ 自定义图像类型扩展
- ✅ 图像导出功能

---

## 2. 安装与配置

### 2.1 系统要求

| 项目 | 要求 |
|------|------|
| VS Code | 1.85.0 或更高版本 |
| 操作系统 | Windows、macOS、Linux（x64/ARM64） |
| 调试器 | GDB, LLDB, MSVC Debugger, 或 debugpy (Python) |

### 2.2 安装插件

#### 方式一：从 VSIX 文件安装

1. 获取 `imview-x.x.x.vsix` 文件
2. 打开 VS Code
3. 按 `Ctrl+Shift+P` 打开命令面板
4. 输入并选择 `Extensions: Install from VSIX...`
5. 选择下载的 `.vsix` 文件
6. 重新加载 VS Code

#### 方式二：命令行安装

```bash
code --install-extension imview-0.1.1.vsix
```

### 2.3 调试器配置

确保已安装以下调试器扩展之一：

| 调试器类型 | 扩展名称 | 适用场景 |
|-----------|---------|---------|
| `cppdbg` | C/C++ (ms-vscode.cpptools) | GDB/LLDB on Linux/macOS/Windows |
| `cppvsdbg` | C/C++ (ms-vscode.cpptools) | MSVC on Windows |
| `lldb` | CodeLLDB (vadimcn.vscode-lldb) | LLDB on Linux/macOS |
| `debugpy` | Python (ms-python.python) | Python debugging |

#### launch.json 示例 (GDB)

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "(gdb) Launch",
            "type": "cppdbg",
            "request": "launch",
            "program": "${workspaceFolder}/build/your_program",
            "args": [],
            "stopAtEntry": false,
            "cwd": "${workspaceFolder}",
            "environment": [],
            "externalConsole": false,
            "MIMode": "gdb",
            "setupCommands": [
                {
                    "description": "Enable pretty-printing",
                    "text": "-enable-pretty-printing",
                    "ignoreFailures": true
                }
            ]
        }
    ]
}
```

#### launch.json 示例 (Python)

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Python: Current File",
            "type": "debugpy",
            "request": "launch",
            "program": "${file}",
            "console": "integratedTerminal"
        }
    ]
}
```

---

## 3. 快速入门

### C++ 快速入门

#### 步骤 1: 编写测试程序

```cpp
#include <opencv2/opencv.hpp>

int main() {
    cv::Mat gray = cv::Mat::zeros(100, 100, CV_8UC1);
    cv::Mat color = cv::Mat::zeros(100, 100, CV_8UC3);

    // 填充一些数据
    for (int y = 0; y < 100; y++) {
        for (int x = 0; x < 100; x++) {
            gray.at<uchar>(y, x) = (x + y) % 256;
            color.at<cv::Vec3b>(y, x) = cv::Vec3b(x*2, y*2, 128);
        }
    }

    // 在此设置断点
    std::cout << "Breakpoint here" << std::endl;

    return 0;
}
```

#### 步骤 2: 启动调试

1. 在 `std::cout` 行设置断点
2. 按 `F5` 启动调试
3. 程序在断点处暂停

### Python 快速入门

#### 步骤 1: 编写测试程序

```python
import numpy as np
import cv2
from PIL import Image
import torch

# NumPy 图像 (通过 OpenCV 读取)
img_cv = cv2.imread('test.jpg')

# NumPy 随机图像
img_np = np.random.randint(0, 255, (100, 100, 3), dtype=np.uint8)

# NumPy 灰度图
img_gray = np.zeros((100, 100), dtype=np.uint8)

# NumPy float 图像
img_float = np.random.rand(50, 50).astype(np.float32)

# PIL 图像
img_pil = Image.fromarray(img_np)

# PyTorch 张量（CHW 格式；加速器数据会自动复制到 CPU）
img_torch = torch.rand(3, 64, 64)

# 在此设置断点
breakpoint()  # 或者在此行点击设置断点
```

#### 步骤 2: 启动调试

1. 在 `breakpoint()` 行设置断点
2. 按 `F5` 启动调试
3. 程序在断点处暂停

### 查看图像

**方法一：从 ImView 面板**
1. 在 VS Code 底部面板区域找到 **ImView** 面板
2. 可以看到自动检测到的图像变量（在 Locals 区域）
3. 点击变量名，图像将显示在 **Image Viewer** 面板中

**方法二：从调试变量面板**
1. 在调试侧边栏的 **VARIABLES** 或 **WATCH** 面板中找到图像变量
2. 右键点击变量，选择 **"View Image"** 立即显示图像
3. 或选择 **"Add to ImView"** 添加到监视列表

**方法三：从代码编辑器**
1. 在代码中选中变量名
2. 右键点击，选择 **"View Image"** 或 **"Add to ImView"**

---

## 4. 界面说明

### 4.1 ImView 列表面板

位于 VS Code 底部的 ImView 面板，显示当前作用域中的图像变量。

```
┌─────────────────────────────────────┐
│ IMAGE WATCH                    [+][↻]│
├─────────────────────────────────────┤
│ ▼ Locals (3)                        │
│   📷 gray      100×100 CV_8UC1      │
│   📷 color     100×100 CV_8UC3      │
│   📷 floatImg  100×100 CV_32FC1     │
├─────────────────────────────────────┤
│ ▼ Watch (1)                         │
│   📷 images[0] 100×100 CV_8UC1      │
└─────────────────────────────────────┘
```

**工具栏按钮：**
- `[+]` - 添加监视表达式
- `[↻]` - 刷新图像列表

**右键菜单：**
- `Open in Editor Tab` - 在新标签页中打开
- `Export Image` - 导出图像
- `Remove Watch` - 删除监视表达式（仅 Watch 项）

### 4.2 Image Viewer 查看器面板

位于 VS Code 底部的 ImView 面板，显示选中的图像内容；也可手动拖到侧边栏。

```
┌─────────────────────────────────────────┐
│ [Fit] [1:1] 100% │ All Channels ▼ │ ☑ Normalize [Export] │
├─────────────────────────────────────────┤
│                                         │
│         ┌─────────────────┐             │
│         │                 │             │
│         │   [图像显示区]   │             │
│         │                 │             │
│         └─────────────────┘             │
│                                         │
├─────────────────────────────────────────┤
│ gray - 100×100 CV_8UC1  │ B:128 │ (50,50) │
└─────────────────────────────────────────┘
```

**工具栏控件：**
| 控件 | 功能 |
|------|------|
| `Fit` | 适应窗口大小 |
| `1:1` | 原始尺寸 (100%) |
| 缩放显示 | 当前缩放百分比 |
| 通道选择 | All/Red/Green/Blue/Alpha |
| Normalize | 自动归一化显示 |
| Export | 导出 PNG、JPEG 或显示缓冲 |

**状态栏信息：**
- 图像名称和尺寸
- 当前像素值
- 鼠标坐标

### 4.3 独立编辑器标签页

右键列表中的图像并选择 `Open in Editor Tab`，可在独立标签页中查看图像；单击列表项会在 Image Viewer 中显示。

独立标签页提供更多功能：
- 更大的显示区域
- Colormap 选择（用于单通道图像）
- A/B 对比按钮
- 导出按钮

---

## 5. 功能详解

### 5.1 自动检测图像变量 (Locals 模式)

当调试器在断点处暂停时，插件会自动扫描当前作用域中的局部变量，识别并列出所有图像类型变量。

**支持的检测类型：**

**C++:**
- `cv::Mat`
- `cv::Mat_<T>`
- `cv::Matx<T, m, n>`
- `cv::Vec<T, n>`
- `CvMat`
- `IplImage`
- 用户自定义类型

**Python:**
- `numpy.ndarray` (包括 OpenCV-Python 返回的数组)
- `PIL.Image.Image`
- `torch.Tensor`（CPU 或加速器）

### 5.2 手动添加监视表达式 (Watch 模式)

点击 `[+]` 按钮或使用命令 `ImView: Add Watch Expression`，可以添加自定义表达式。

**支持的表达式格式：**

```cpp
// 简单变量
myImage

// 数组元素
images[0]
images[index]

// 指针成员
ptr->frame
obj.getImage()

// 带操作符的表达式
@abs(diff_image)
@band(color, 0)
```

**持久化：** Watch 表达式会保存到工作区状态，下次打开项目时自动恢复。

### 5.3 图像查看与交互

#### 缩放操作

| 操作 | 方法 |
|------|------|
| 放大/缩小 | 鼠标滚轮 |
| 适应窗口 | 点击 `Fit` 按钮 或 按 `F` 键 |
| 原始尺寸 | 点击 `1:1` 按钮 或 按 `0` 键 |
| 重置视图 | 双击画布 |

#### 平移操作

| 操作 | 方法 |
|------|------|
| 平移图像 | 鼠标左键拖拽 |

### 5.4 像素值检查

将鼠标移动到图像上时，状态栏会实时显示：

- **坐标**：`(x, y)` 格式
- **像素值**：各通道值，如 `B:128 G:64 R:255`

**高缩放级别显示：** 当缩放倍数 ≥ 8x 时，像素值会直接叠加显示在每个像素上。

**复制像素值：** 按 `Ctrl+C` 复制当前鼠标位置的像素值到剪贴板。

### 5.5 显示选项

#### 通道查看

从下拉菜单选择要查看的通道：

| 选项 | 说明 |
|------|------|
| All Channels | 显示所有通道（彩色图像） |
| Red | 仅显示红色通道（灰度显示） |
| Green | 仅显示绿色通道（灰度显示） |
| Blue | 仅显示蓝色通道（灰度显示） |
| Alpha | 仅显示 Alpha 通道（4通道图像） |

快捷键：按 `1`-`4` 切换通道视图。

#### 自动归一化

勾选 `Normalize` 选项可自动调整显示范围：

- **uint8 图像**：0-255 映射到显示范围
- **float 图像**：自动检测 min/max 并归一化
- **int16 图像**：自动检测 min/max 并归一化

#### 色彩映射 (Colormap)

单通道图像可应用伪彩色显示（在编辑器标签页中可用）：

| Colormap | 描述 |
|----------|------|
| Grayscale | 灰度（默认） |
| Jet | 蓝→青→黄→红 |
| Hot | 黑→红→黄→白 |
| Cool | 青→紫 |
| Viridis | 紫→蓝→绿→黄 |
| Plasma | 紫→橙→黄 |

### 5.6 图像操作符

使用 `@` 前缀的操作符可以对图像进行实时变换。在 Watch 表达式中使用。

#### 基础操作符

| 操作符 | 语法 | 功能 |
|--------|------|------|
| `@band` | `@band(img, n)` | 提取第 n 个通道 (0-based) |
| `@abs` | `@abs(img)` | 取绝对值 |
| `@scale` | `@scale(img, factor)` | 缩放像素值 |
| `@thresh` | `@thresh(img, t)` | 二值化阈值处理 |
| `@clamp` | `@clamp(img, min, max)` | 限制值域范围 |
| `@norm8` | `@norm8(img)` | 除以 255，输出 float32 |
| `@norm16` | `@norm16(img)` | 除以 65535，输出 float32 |

#### 几何变换操作符

| 操作符 | 语法 | 功能 |
|--------|------|------|
| `@fliph` | `@fliph(img)` | 水平翻转 |
| `@flipv` | `@flipv(img)` | 垂直翻转 |
| `@rot90` | `@rot90(img)` | 顺时针旋转 90° |
| `@rot180` | `@rot180(img)` | 旋转 180° |
| `@rot270` | `@rot270(img)` | 顺时针旋转 270° |

#### 双图像操作符

| 操作符 | 语法 | 功能 |
|--------|------|------|
| `@diff` | `@diff(img1, img2)` | 计算绝对差异 |

#### 原始内存

`@mem(address, type, channels, width, height[, stride])` 可直接查看调试进程中的原始缓冲区：

```text
@mem(0x12345678, uint8, 3, 640, 480)
@mem(0x12345678, uint16, 1, 640, 480, 1280)
```

地址必须是非空十六进制指针，通道数为 1–4。省略 `stride` 时按紧密排列计算；读取前会校验尺寸、最小行步长和 `imview.maxImageBytes`。

#### 操作符嵌套

操作符可以嵌套使用：

```
@abs(@diff(image1, image2))
@scale(@band(color, 0), 2.0)
@thresh(@abs(diff), 10)
```

#### 示例用法

```
# 提取蓝色通道
@band(color_image, 0)

# 比较两帧差异
@abs(@diff(frame1, frame2))

# 提取高于阈值的区域
@thresh(@band(gray, 0), 128)

# 归一化 16-bit 图像
@norm16(depth_image)
```

### 5.7 图像导出

右键点击图像列表项，选择 `Export Image`，支持以下格式：

| 格式 | 扩展名 | 说明 |
|------|--------|------|
| PNG | `.png` | 无损导出当前渲染结果，保留 Alpha |
| JPEG | `.jpg` / `.jpeg` | 有损导出当前渲染结果，透明区域合成为白色 |
| Binary | `.bin` | 导出送入查看器的像素缓冲，不进行图像编码 |

PNG/JPEG 会包含当前的归一化、色图、通道选择和 Alpha 处理结果，但不包含缩放、网格或像素检查覆盖层。JPEG 质量由 `imview.jpegQuality` 控制。

**Binary 格式说明：**
`.bin` 文件保留 `depth`、`channels` 和 `stride` 对应的字节布局。非连续 ROI 可能包含行间 padding；PyTorch CHW 数据会先转换为查看器使用的 HWC 布局。

### 5.8 A/B 对比功能

在编辑器标签页中，可以快速在两张图像间切换对比：

1. 打开第一张图像
2. 使用 `Open in Editor Tab` 打开第二张图像；它会与上一次打开的图像组成当前标签页的 A/B 对
3. 点击 `A/B` 按钮或按 `空格键` 切换显示

视图状态（缩放、平移）在切换时保持不变，便于精确对比。

---

## 6. 支持的图像类型

### 6.1 Python 图像类型

#### numpy.ndarray

NumPy 数组是 Python 中最常用的图像格式，也是 OpenCV-Python 和 scikit-image 的默认格式。

| 维度 | 格式 | 说明 |
|------|------|------|
| 2D (H, W) | 灰度图 | 单通道图像 |
| 3D (H, W, C) | 彩色图 | C 为通道数 (1-4) |

**支持的 dtype：**

| NumPy dtype | 说明 |
|-------------|------|
| `uint8` | 最常用格式 (0-255) |
| `int8` | 有符号字节 |
| `uint16` | 高精度灰度 |
| `int16` | 有符号短整数 |
| `int32` | 整数图像 |
| `float32` | 浮点图像 |
| `float64` | 双精度浮点 |
| `float16` | 半精度浮点 |

#### PIL.Image.Image

Pillow 图像对象，支持多种模式：

| 模式 | 说明 |
|------|------|
| `L` | 灰度 |
| `RGB` | 24-bit 彩色 |
| `RGBA` | 32-bit 带透明通道 |
| `I` | 32-bit 整数 |
| `F` | 32-bit 浮点 |

#### torch.Tensor

PyTorch 张量会转换为连续 CPU 存储，再直接读取原始字节；此路径不依赖 NumPy ABI。CUDA、MPS 等加速器上的张量会先复制到 CPU。

| 维度 | 格式 | 说明 |
|------|------|------|
| 2D (H, W) | 灰度图 | 单通道 |
| 3D (C, H, W) | CHW 格式 | PyTorch 默认格式 |
| 4D (N, C, H, W) | 批量图像 | 取第一张 |

**注意事项：**
- 大型 GPU 张量的设备到主机复制可能增加断点停顿时间
- CHW 格式会自动转换为 HWC 格式显示
- 支持 `torch.float32`, `torch.float64`, `torch.uint8` 等常见 dtype

### 6.2 C++ OpenCV 类型

#### cv::Mat

标准 OpenCV 矩阵类型，支持所有像素格式：

| 类型 | 深度 | 说明 |
|------|------|------|
| CV_8UC1/3/4 | 8-bit unsigned | 最常用格式 |
| CV_8SC1/3/4 | 8-bit signed | 有符号字节 |
| CV_16UC1/3/4 | 16-bit unsigned | 高精度灰度 |
| CV_16SC1/3/4 | 16-bit signed | 有符号短整数 |
| CV_32SC1/3/4 | 32-bit signed | 整数图像 |
| CV_32FC1/3/4 | 32-bit float | 浮点图像 |
| CV_64FC1/3/4 | 64-bit float | 双精度浮点 |

#### cv::Mat_<T>

模板化矩阵类型，自动识别模板参数：

```cpp
cv::Mat_<uchar> gray;
cv::Mat_<cv::Vec3b> color;
cv::Mat_<float> floatImg;
```

#### cv::Matx<T, m, n>

小型固定尺寸矩阵（数据内联存储）：

```cpp
cv::Matx33f rotation;
cv::Matx44d transform;
```

#### cv::Vec<T, n>

向量类型（作为 1×n 图像显示）：

```cpp
cv::Vec3f point;
cv::Vec4b pixel;
```

#### 旧版类型

| 类型 | 说明 |
|------|------|
| CvMat | OpenCV C 接口矩阵 |
| IplImage | OpenCV 1.x 图像格式 |

### 6.3 自定义类型配置

对于非 OpenCV 的图像类型，可以通过配置文件定义解析规则。

在 VS Code 设置中添加 `imview.customTypes`：

```json
{
    "imview.customTypes": [
        {
            "typeName": "MyImage",
            "properties": {
                "width": "m_width",
                "height": "m_height",
                "channels": 3,
                "data": "m_data",
                "stride": "m_rowStride",
                "pixelType": "uint8"
            }
        },
        {
            "typeName": "stbi_image",
            "properties": {
                "width": "width",
                "height": "height",
                "channels": "comp",
                "data": "data",
                "stride": "auto",
                "pixelType": "uint8"
            }
        }
    ]
}
```

**配置字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `typeName` | string | C++ 类型名称（支持通配符 `*`） |
| `width` | string | 获取宽度的成员表达式 |
| `height` | string | 获取高度的成员表达式 |
| `channels` | string \| number | 通道数（表达式或常量） |
| `data` | string | 数据指针成员表达式 |
| `stride` | string | 行步长表达式，`"auto"` 表示自动计算 |
| `pixelType` | string | 像素类型：`uint8`, `int8`, `uint16`, `int16`, `int32`, `float32`, `float64` |
| `isValid` | string | 可选的缓冲区有效性布尔表达式 |

---

## 7. 配置选项

在 VS Code 设置中搜索 `imview` 查看所有选项：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `imview.autoRefresh` | `true` | 断点暂停时自动刷新图像 |
| `imview.defaultColormap` | `"grayscale"` | 单通道图像默认色彩映射 |
| `imview.maxImageSize` | `4096` | 最大支持的图像尺寸 |
| `imview.maxImageBytes` | `268435456` | 单张图像最大调试器传输字节数 |
| `imview.numpyChannelOrder` | `"bgr"` | NumPy 三/四通道数组的默认通道顺序 |
| `imview.jpegQuality` | `0.92` | JPEG 导出质量（0.1–1.0） |
| `imview.autoNormalize` | `true` | 自动归一化非 8-bit 图像 |
| `imview.showPixelGrid` | `true` | 高缩放时显示像素网格 |
| `imview.pixelGridZoomThreshold` | `8` | 显示像素网格的最小缩放倍数 |
| `imview.customTypes` | `[]` | 自定义图像类型配置 |

### settings.json 示例

```json
{
    "imview.autoRefresh": true,
    "imview.defaultColormap": "viridis",
    "imview.maxImageSize": 8192,
    "imview.maxImageBytes": 268435456,
    "imview.numpyChannelOrder": "bgr",
    "imview.jpegQuality": 0.92,
    "imview.showPixelGrid": true,
    "imview.pixelGridZoomThreshold": 10,
    "imview.customTypes": []
}
```

---

## 8. 快捷键参考

### 图像查看器快捷键

| 快捷键 | 功能 |
|--------|------|
| `F` | 适应窗口 |
| `0` | 原始尺寸 (100%) |
| `1` | 查看红色通道 |
| `2` | 查看绿色通道 |
| `3` | 查看蓝色通道 |
| `4` | 查看 Alpha 通道 |
| `空格` | A/B 对比切换 |
| `Ctrl+C` / `Cmd+C` | 复制当前像素值 |
| `滚轮` | 缩放 |
| `拖拽` | 平移 |
| `双击` | 重置视图 |

### 命令面板命令

按 `Ctrl+Shift+P` 打开命令面板，输入 "ImView"：

| 命令 | 功能 |
|------|------|
| `ImView: Refresh Images` | 刷新图像列表 |
| `ImView: Add Watch Expression` | 添加监视表达式 |
| `ImView: Open in Editor Tab` | 在编辑器标签页打开 |
| `ImView: Export Image` | 导出图像 |

---

## 9. 故障排除

### 问题：图像列表为空

**可能原因：**
1. 调试器未在断点处暂停
2. 当前作用域没有图像类型变量
3. 调试器类型不支持

**解决方案：**
- 确保调试器已暂停（在断点处停止）
- 检查变量是否在当前作用域内
- 确认使用支持的调试器（cppdbg, cppvsdbg, lldb）

### 问题：图像显示失败

**错误信息：** "Failed to read image data from memory"

**可能原因：**
1. 图像数据指针为空
2. 图像尺寸过大
3. 调试器不支持 readMemory 请求

**解决方案：**
- 检查图像是否已正确初始化
- 减小图像尺寸或调整 `maxImageSize` 设置
- 尝试使用不同的调试器

### 问题：自定义类型无法识别

**解决方案：**
1. 检查 `typeName` 是否与调试器显示的类型名匹配
2. 验证成员名称拼写正确
3. 确保 `pixelType` 是有效值

### 问题：像素值显示不正确

**可能原因：**
- 图像数据为 BGR 格式（OpenCV 默认）
- 需要归一化但未启用

**解决方案：**
- 插件会自动进行 BGR→RGB 转换显示
- 勾选 `Normalize` 选项

### 问题：调试器性能慢

**可能原因：**
- 图像数据量大
- 频繁刷新

**解决方案：**
- 减小查看的图像数量
- 禁用 `autoRefresh` 选项，手动刷新
- 使用较小的测试图像

---

## 10. 更新日志

### v0.1.1 (2026-03-15)

**新增 Python 调试器支持**

- ✅ 支持 Python debugpy 调试器
- ✅ 支持 `numpy.ndarray` 图像可视化 (包括 OpenCV-Python)
- ✅ 支持 `PIL.Image.Image` 图像可视化
- ✅ 支持 `torch.Tensor` 张量可视化（加速器张量自动复制到 CPU）
- ✅ 自动处理 PyTorch CHW 格式转换为 HWC
- ✅ 支持多种 NumPy dtype (uint8, int8, uint16, int16, int32, float32, float64)
- ✅ 分块传输大图像数据，解决 debugpy 输出限制问题

### v0.1.0 (2026-03-14)

**初始版本发布**

- ✅ 支持 cv::Mat, cv::Mat_<T>, cv::Matx, cv::Vec 类型
- ✅ 支持 CvMat, IplImage 旧版类型
- ✅ 支持 cppdbg, cppvsdbg, lldb 调试器
- ✅ 实现底部面板图像列表 (Locals + Watch)
- ✅ 实现底部面板图像查看器
- ✅ 实现独立编辑器标签页模式
- ✅ 实现缩放、平移、像素检查功能
- ✅ 实现图像操作符 (@band, @abs, @diff 等)
- ✅ 实现自定义类型配置
- ✅ 实现图像导出功能
- ✅ 实现 A/B 对比功能
- ✅ 支持右键菜单快速添加变量到监视列表
- ✅ 支持从代码编辑器选中变量直接可视化
- ✅ 支持 Windows、macOS、Linux（x64/ARM64）

---

## 附录

### A. 示例代码

```cpp
#include <opencv2/opencv.hpp>

int main() {
    // 测试各种图像类型
    cv::Mat gray = cv::Mat::zeros(100, 100, CV_8UC1);
    cv::Mat color = cv::Mat::zeros(100, 100, CV_8UC3);
    cv::Mat floatImg = cv::Mat::zeros(100, 100, CV_32FC1);
    cv::Mat rgba = cv::Mat::zeros(100, 100, CV_8UC4);

    // 设置断点，使用 ImView 查看这些图像
    return 0;
}
```

### B. 相关资源

- [OpenCV 官方文档](https://docs.opencv.org/)
- [VS Code 调试文档](https://code.visualstudio.com/docs/editor/debugging)
- [项目 GitHub 仓库](https://github.com/your-repo/imview)

---

*本手册由 ImView for VS Code 开发团队维护*
