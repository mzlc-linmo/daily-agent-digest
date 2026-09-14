// 从 App 图标源图生成菜单栏用的 Template 图标。
//
//   swift native/macos/make-menubar-icon.swift <源图 1024.png> <输出目录>
//
// 为什么需要单独生成:菜单栏图标必须是**纯黑 + alpha 的 Template 图标**,系统才会
// 按浅色/深色菜单栏自动反色。彩色的 App 图标放上去会变成一团灰,而且 18pt 下细节全糊。
// 这里取"背景色 → 主体轮廓"的差值做遮罩,得到单色剪影,并按 1x/2x 输出 18/36 像素。

import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(Data("用法: make-menubar-icon.swift <源图.png> <输出目录>\n".utf8))
    exit(2)
}
let sourcePath = args[1]
let outputDir = URL(fileURLWithPath: args[2], isDirectory: true)
try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

guard let source = NSImage(contentsOfFile: sourcePath),
      let cg = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write(Data("无法读取源图:\(sourcePath)\n".utf8))
    exit(1)
}

let width = cg.width, height = cg.height
var pixels = [UInt8](repeating: 0, count: width * height * 4)
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: &pixels, width: width, height: height,
                          bitsPerComponent: 8, bytesPerRow: width * 4, space: colorSpace,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))

/// 取四角平均值作为背景色
func rgb(_ x: Int, _ y: Int) -> (Double, Double, Double) {
    let i = (y * width + x) * 4
    return (Double(pixels[i]), Double(pixels[i + 1]), Double(pixels[i + 2]))
}
let corners = [rgb(0, 0), rgb(width - 1, 0), rgb(0, height - 1), rgb(width - 1, height - 1)]
let bg = (corners.map { $0.0 }.reduce(0, +) / 4, corners.map { $0.1 }.reduce(0, +) / 4, corners.map { $0.2 }.reduce(0, +) / 4)

/// 与背景的色差 → 主体遮罩;阈值取得偏保守,避免把抗锯齿边缘也当成主体
var mask = [Double](repeating: 0, count: width * height)
for y in 0..<height {
    for x in 0..<width {
        let (r, g, b) = rgb(x, y)
        let distance = sqrt(pow(r - bg.0, 2) + pow(g - bg.1, 2) + pow(b - bg.2, 2))
        var alpha = min(1, max(0, (distance - 25) / 40))
        // 眼睛是高亮青色(min(G,B) 远高于 R),它是这个形象最可辨认的特征 ——
        // 直接留成实心剪影就会丢掉;这里把它挖成"孔",深浅色菜单栏下都清晰。
        let cyanness = min(g, b) - r
        if cyanness > 110 && (0.299 * r + 0.587 * g + 0.114 * b) > 170 { alpha = 0 }
        mask[y * width + x] = alpha
    }
}

/// 盒式降采样到目标边长(直接最近邻会有锯齿,菜单栏上很难看)
func render(size: Int) -> CGImage? {
    let scale = Double(width) / Double(size)
    var out = [UInt8](repeating: 0, count: size * size * 4)
    for y in 0..<size {
        for x in 0..<size {
            var sum = 0.0, count = 0.0
            let x0 = Int(Double(x) * scale), x1 = min(width, Int(Double(x + 1) * scale))
            let y0 = Int(Double(y) * scale), y1 = min(height, Int(Double(y + 1) * scale))
            for sy in y0..<max(y0 + 1, y1) {
                for sx in x0..<max(x0 + 1, x1) {
                    sum += mask[sy * width + sx]; count += 1
                }
            }
            let alpha = count > 0 ? sum / count : 0
            let i = (y * size + x) * 4
            out[i] = 0; out[i + 1] = 0; out[i + 2] = 0            // Template 图标:纯黑
            out[i + 3] = UInt8(min(255, max(0, alpha * 255)))     // 只靠 alpha 表达形状
        }
    }
    guard let provider = CGDataProvider(data: Data(out) as CFData) else { return nil }
    return CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 32,
                   bytesPerRow: size * 4, space: colorSpace,
                   bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
}

func write(_ image: CGImage, to url: URL) {
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
}

for (size, name) in [(18, "MenuBarIconTemplate.png"), (36, "MenuBarIconTemplate@2x.png"), (54, "MenuBarIconTemplate@3x.png")] {
    if let image = render(size: size) { write(image, to: outputDir.appendingPathComponent(name)) }
    print("  ✓ \(name) (\(size)px)")
}
