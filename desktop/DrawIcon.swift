import AppKit

// Original artwork. Coordinates match icon.svg; render each size for crisp edges.
let output = CommandLine.arguments[1]
let sizes = [(16,1),(16,2),(32,1),(32,2),(128,1),(128,2),(256,1),(256,2),(512,1),(512,2)]
let fm = FileManager.default
try fm.createDirectory(atPath: output, withIntermediateDirectories: true)
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: r/255, green: g/255, blue: b/255, alpha: a)
}
let mint = color(126,226,184), blue = color(130,170,255), lilac = color(199,146,234)
for (size, scale) in sizes {
    let pixels = size * scale
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let context = NSGraphicsContext.current!.cgContext
    context.scaleBy(x: CGFloat(pixels)/1024, y: CGFloat(pixels)/1024)
    let base = NSBezierPath(roundedRect: NSRect(x: 64,y: 64,width: 896,height: 896), xRadius: 208,yRadius: 208)
    let gradient = NSGradient(starting: color(25,34,52), ending: color(11,14,20))!
    gradient.draw(in: base, angle: -70)
    color(75,91,121,0.6).setStroke(); base.lineWidth = 3; base.stroke()
    let ring = NSBezierPath(ovalIn: NSRect(x: 244,y:244,width:536,height:536))
    color(130,170,255,0.10).setStroke(); ring.lineWidth = 3; ring.stroke()
    let hub = NSPoint(x:512,y:512)
    let nodes: [(NSPoint,NSColor)] = [(NSPoint(x:512,y:766),mint),(NSPoint(x:288,y:382),blue),(NSPoint(x:736,y:382),lilac)]
    for (point, ink) in nodes {
        let line = NSBezierPath(); line.move(to: hub); line.line(to: point)
        color(ink.redComponent*255,ink.greenComponent*255,ink.blueComponent*255,0.20).setStroke()
        line.lineWidth = 40; line.lineCapStyle = .round; line.stroke()
        ink.setStroke(); line.lineWidth = 15; line.stroke()
        let glow = NSBezierPath(ovalIn: NSRect(x:point.x-76,y:point.y-76,width:152,height:152))
        color(ink.redComponent*255,ink.greenComponent*255,ink.blueComponent*255,0.07).setFill(); glow.fill()
        let node = NSBezierPath(roundedRect:NSRect(x:point.x-48,y:point.y-48,width:96,height:96),xRadius:30,yRadius:30)
        color(21,29,43).setFill(); node.fill(); ink.setStroke(); node.lineWidth=11; node.stroke()
        ink.setFill(); NSBezierPath(ovalIn:NSRect(x:point.x-12,y:point.y-12,width:24,height:24)).fill()
    }
    let core = NSBezierPath(roundedRect: NSRect(x:423,y:423,width:178,height:178),xRadius:52,yRadius:52)
    color(15,23,34).setFill(); core.fill(); mint.setStroke(); core.lineWidth=12; core.stroke()
    mint.setFill()
    for x in [478,512,546] { NSBezierPath(ovalIn:NSRect(x:x-7,y:505,width:14,height:14)).fill() }
    NSGraphicsContext.restoreGraphicsState()
    let suffix = scale == 2 ? "@2x" : ""
    let data = bitmap.representation(using:.png,properties:[:])!
    try data.write(to: URL(fileURLWithPath:output).appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
}
