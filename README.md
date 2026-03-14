# ImView for VS Code

A VS Code extension for visualizing image data during C/C++ debugging sessions. Similar to Visual Studio's ImView, this extension allows you to inspect OpenCV `cv::Mat` and other image types in real-time while debugging.

## Features

- **Real-time Image Visualization**: View image variables during debug sessions
- **Multiple Image Types**: Support for OpenCV `cv::Mat`, `cv::Mat_<T>`, `cv::Matx`, `CvMat`, `IplImage`, and custom types
- **Multiple Debuggers**: Works with GDB (`cppdbg`), LLDB (`lldb`), and MSVC (`cppvsdbg`) debuggers
- **Interactive Viewer**:
  - Zoom and pan with mouse wheel and drag
  - Pixel value inspection on hover
  - Channel-wise viewing (R/G/B/A)
  - Auto-normalization for non-8-bit images
  - Colormap support for single-channel images (grayscale, jet, hot, cool, viridis, plasma)
- **Dual View Modes**: Sidebar panel and separate editor tab modes
- **Context Menu Integration**: Right-click on variables in the debug panel to view or add to watch list
- **Watch Expressions**: Add custom expressions to watch list
- **Export**: Save images to raw binary format

## Supported Platforms

- Windows x86/x64
- Linux x86/x64

## Supported Image Types

| Type | Description |
|------|-------------|
| `cv::Mat` | Standard OpenCV matrix |
| `cv::Mat_<T>` | Typed OpenCV matrix template |
| `cv::Matx<T,m,n>` | Small fixed-size matrix |
| `cv::Vec<T,n>` | Small vector |
| `CvMat` | Legacy OpenCV C interface |
| `IplImage` | OpenCV 1.x image format |
| Custom types | User-defined via configuration |

## Supported Pixel Depths

| OpenCV Type | Description |
|-------------|-------------|
| CV_8U | 8-bit unsigned |
| CV_8S | 8-bit signed |
| CV_16U | 16-bit unsigned |
| CV_16S | 16-bit signed |
| CV_32S | 32-bit signed integer |
| CV_32F | 32-bit float |
| CV_64F | 64-bit float |

## Usage

### Quick Start

1. Start a debug session with a C/C++ program that uses OpenCV
2. Set a breakpoint where image variables are in scope
3. When the debugger stops, the **ImView** panel shows detected image variables
4. Click on an image to view it in the viewer panel

### Viewing Images from Debug Variables

- **Right-click** on any variable in the VARIABLES or WATCH panel
- Select **"View Image"** to display the image immediately
- Select **"Add to ImView"** to add to the watch list

### Viewing Images from Editor

- **Select** a variable name in the code editor
- **Right-click** and select **"View Image"** or **"Add to ImView"**

### Watch Expressions

Add custom expressions to monitor:
- Click the **+** button in the Image List panel
- Enter expressions like `myImage`, `images[0]`, or `ptr->frame`

### Viewer Controls

| Action | How to |
|--------|--------|
| Zoom | Mouse wheel |
| Pan | Click and drag |
| Fit to window | Click "Fit" button |
| Actual size | Click "1:1" button |
| View channel | Select from dropdown |
| Normalize | Toggle checkbox |

### Image Operators

Transform images using `@` operators in watch expressions:

```
@abs(img)              - Absolute value
@band(img, n)          - Extract channel n
@thresh(img, t)        - Binary threshold
@clamp(img, min, max)  - Clamp values
@scale(img, f)         - Scale by factor
@norm8(img)            - Normalize /255
@norm16(img)           - Normalize /65535
@diff(img1, img2)      - Absolute difference
@fliph(img)            - Flip horizontal
@flipv(img)            - Flip vertical
@rot90(img)            - Rotate 90° CW
@rot180(img)           - Rotate 180°
@rot270(img)           - Rotate 270° CW
```

Operators can be nested: `@abs(@diff(img1, img2))`

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `imview.autoRefresh` | `true` | Refresh images when debugger stops |
| `imview.defaultColormap` | `grayscale` | Default colormap for single-channel images |
| `imview.maxImageSize` | `4096` | Maximum image dimension |
| `imview.showPixelGrid` | `true` | Show pixel grid when zoomed in |
| `imview.pixelGridZoomThreshold` | `8` | Minimum zoom to show pixel grid |
| `imview.autoNormalize` | `true` | Auto-normalize values for display |
| `imview.customTypes` | `[]` | Custom image type definitions |

### Custom Type Configuration

Define custom image types in settings:

```json
"imview.customTypes": [
  {
    "typeName": "MyImage",
    "properties": {
      "width": "m_width",
      "height": "m_height",
      "channels": 3,
      "data": "m_data",
      "stride": "m_stride",
      "pixelType": "uint8"
    }
  }
]
```

Supported `pixelType` values: `uint8`, `int8`, `uint16`, `int16`, `int32`, `float32`, `float64`

## Requirements

- VS Code 1.85.0 or later
- One of the following debugger extensions:
  - [C/C++ Extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) (for `cppdbg` and `cppvsdbg`)
  - [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) (for `lldb`)

## Installation

### From VSIX

```bash
code --install-extension imview-0.1.0.vsix
```

### Building from Source

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Package
npx vsce package --allow-missing-repository
```

## Known Limitations

- Large images (>16384 pixels in either dimension) may cause performance issues
- Some debugger configurations may not support `readMemory` requests
- PNG/JPG export is not fully implemented (use binary export instead)

## Troubleshooting

### Image not displaying

1. Make sure the debugger is paused at a breakpoint
2. Verify the variable is in scope
3. Check the Output panel for error messages

### "Debugger must be paused" message

The debugger must be stopped at a breakpoint to read memory. Step through your code or set a breakpoint.

### Variable not recognized as image type

The extension recognizes OpenCV types by their type names. If using a custom type, configure it in `imview.customTypes`.

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
