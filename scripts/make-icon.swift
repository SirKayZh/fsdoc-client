// 生成 build/icon.icns：蓝色圆角方块 + 白色文档（右上折角 + 文字线）
// 用法：swift scripts/make-icon.swift
import AppKit

func render(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let blue = NSColor(red: 0x33/255, green: 0x70/255, blue: 0xFF/255, alpha: 1)

    // macOS 图标留白：内容占 ~82%
    let m = s * 0.09
    let bg = NSRect(x: m, y: m, width: s - 2*m, height: s - 2*m)
    blue.setFill()
    NSBezierPath(roundedRect: bg, xRadius: bg.width * 0.225, yRadius: bg.width * 0.225).fill()

    // 白色文档
    let dw = bg.width * 0.46, dh = bg.height * 0.58
    let dx = bg.midX - dw/2, dy = bg.midY - dh/2
    let fold = dw * 0.30
    let page = NSBezierPath()
    page.move(to: NSPoint(x: dx, y: dy))
    page.line(to: NSPoint(x: dx + dw, y: dy))
    page.line(to: NSPoint(x: dx + dw, y: dy + dh - fold))
    page.line(to: NSPoint(x: dx + dw - fold, y: dy + dh))
    page.line(to: NSPoint(x: dx, y: dy + dh))
    page.close()
    NSColor.white.setFill()
    page.fill()

    // 折角
    let corner = NSBezierPath()
    corner.move(to: NSPoint(x: dx + dw - fold, y: dy + dh))
    corner.line(to: NSPoint(x: dx + dw - fold, y: dy + dh - fold))
    corner.line(to: NSPoint(x: dx + dw, y: dy + dh - fold))
    corner.close()
    NSColor(red: 0.78, green: 0.85, blue: 1.0, alpha: 1).setFill()
    corner.fill()

    // 文字线
    blue.withAlphaComponent(0.85).setFill()
    let lx = dx + dw * 0.14, lw = dw * 0.72, lh = dh * 0.065
    for (i, f) in [0.40, 0.27, 0.14].enumerated() {
        let w = i == 2 ? lw * 0.6 : lw
        let r = NSRect(x: lx, y: dy + dh * CGFloat(f), width: w, height: lh)
        NSBezierPath(roundedRect: r, xRadius: lh/2, yRadius: lh/2).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let dir = "build/icon.iconset"
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
// iconutil 要求的文件名：icon_16x16.png / icon_16x16@2x.png ...
let sizes: [(String, Int)] = [("16x16",16),("16x16@2x",32),("32x32",32),("32x32@2x",64),("128x128",128),
                              ("128x128@2x",256),("256x256",256),("256x256@2x",512),("512x512",512),("512x512@2x",1024)]
for (n, px) in sizes {
    try! render(px).write(to: URL(fileURLWithPath: "\(dir)/icon_\(n).png"))
}
