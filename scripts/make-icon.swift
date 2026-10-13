// 生成 build/icon.icns：白底圆角方块 + 飞书 logo + 「飞书文档」+「轻量版」徽章
// 用法：npm run icon（先确保 build/feishu-mark.png 存在）
import AppKit

// 加载 logo 并把逻辑尺寸归一化为像素尺寸（该 PNG 的 DPI 元数据异常，img.size 不可信）
func loadLogo(_ path: String) -> NSImage {
    let img = NSImage(contentsOfFile: path)!
    let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
    img.size = NSSize(width: CGFloat(rep.pixelsWide), height: CGFloat(rep.pixelsHigh))
    return img
}

func drawText(_ s: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> (NSImage) -> Void {
    return { ctx in
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        let attr: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: color,
            .paragraphStyle: para,
        ]
        let str = NSAttributedString(string: s, attributes: attr)
        let bounds = str.boundingRect(with: NSSize(width: 10000, height: 10000),
                                      options: [.usesLineFragmentOrigin])
        str.draw(in: NSRect(x: (ctx.size.width - bounds.width) / 2,
                            y: (ctx.size.height - bounds.height) / 2,
                            width: bounds.width, height: bounds.height))
    }
}

func render(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    let ink = NSColor(red: 0x1F/255, green: 0x23/255, blue: 0x29/255, alpha: 1)   // 飞书正文深灰
    let blue = NSColor(red: 0x33/255, green: 0x70/255, blue: 0xFF/255, alpha: 1)  // 飞书品牌蓝

    // macOS 图标留白：内容占 ~82%
    let m = s * 0.09
    let bg = NSRect(x: m, y: m, width: s - 2*m, height: s - 2*m)
    NSColor.white.setFill()
    NSBezierPath(roundedRect: bg, xRadius: bg.width * 0.225, yRadius: bg.width * 0.225).fill()
    NSColor(white: 0, alpha: 0.06).setStroke()
    let border = NSBezierPath(roundedRect: bg.insetBy(dx: 1, dy: 1), xRadius: bg.width * 0.225, yRadius: bg.width * 0.225)
    border.lineWidth = max(1, s * 0.002)
    border.stroke()

    let logo = loadLogo("build/feishu-mark.png")

    // 1) logo：宽约 52%，垂直居上
    let lw = bg.width * 0.52
    let lh = lw * (logo.size.height / logo.size.width)
    let ly = bg.maxY - bg.height * 0.075 - lh
    NSGraphicsContext.current!.imageInterpolation = .high
    logo.draw(in: NSRect(x: bg.midX - lw/2, y: ly, width: lw, height: lh),
              from: .zero, operation: .sourceOver, fraction: 1)

    // 2) 「飞书文档」
    let nameSize = bg.width * 0.155
    let nameH = nameSize * 1.3
    let nameY = ly - bg.height * 0.055 - nameH
    let nameLayer = NSImage(size: NSSize(width: bg.width, height: nameH))
    nameLayer.lockFocus()
    drawText("飞书文档", size: nameSize, weight: .bold, color: ink)(nameLayer)
    nameLayer.unlockFocus()
    nameLayer.draw(in: NSRect(x: bg.origin.x, y: nameY, width: bg.width, height: nameH),
                   from: .zero, operation: .sourceOver, fraction: 1)

    // 3) 「轻量版」徽章：品牌蓝圆角胶囊 + 白字
    let pillH = bg.height * 0.115
    let pillW = bg.width * 0.30
    let pillY = nameY - bg.height * 0.045 - pillH
    let pill = NSRect(x: bg.midX - pillW/2, y: pillY, width: pillW, height: pillH)
    blue.setFill()
    NSBezierPath(roundedRect: pill, xRadius: pillH/2, yRadius: pillH/2).fill()
    let pillLayer = NSImage(size: pill.size)
    pillLayer.lockFocus()
    drawText("轻量版", size: pillH * 0.56, weight: .semibold, color: .white)(pillLayer)
    pillLayer.unlockFocus()
    pillLayer.draw(in: pill, from: .zero, operation: .sourceOver, fraction: 1)

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let dir = "build/icon.iconset"
try? FileManager.default.removeItem(atPath: dir)
try! FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
// iconutil 要求的文件名：icon_16x16.png / icon_16x16@2x.png ...
let sizes: [(String, Int)] = [("16x16",16),("16x16@2x",32),("32x32",32),("32x32@2x",64),("128x128",128),
                              ("128x128@2x",256),("256x256",256),("256x256@2x",512),("512x512",512),("512x512@2x",1024)]
for (n, px) in sizes {
    try! render(px).write(to: URL(fileURLWithPath: "\(dir)/icon_\(n).png"))
}
