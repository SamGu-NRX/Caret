// Joins per-window captures into one picture, for evidence of what the fill overlay looks like
// over a fixture window that sits behind other windows. Each input is a `screencapture -l` PNG of
// one window (the fixture's, or one of the host's own panels) with its frame in global top-left
// points; the first input is the base and sets the canvas. Nothing but those windows is drawn, so
// whatever else is on the screen never reaches the file.
//
// Build: swiftc -O compose-shot.swift -o ../.build/compose-shot
// Usage: compose-shot <out.png> <base.png>:<x>,<y>,<w>,<h> [<panel.png>:<x>,<y>,<w>,<h> ...]

import AppKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("compose-shot: \(message)\n".utf8))
    exit(2)
}

struct Layer {
    let image: NSImage
    let frame: CGRect
}

func parse(_ arg: String) -> Layer {
    guard let colon = arg.lastIndex(of: ":") else { fail("expected file:x,y,w,h, got \(arg)") }
    let path = String(arg[..<colon])
    let numbers = arg[arg.index(after: colon)...].split(separator: ",").compactMap { Double($0) }
    guard numbers.count == 4, let image = NSImage(contentsOfFile: path) else { fail("cannot read \(arg)") }
    return Layer(image: image, frame: CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3]))
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else { fail("usage: compose-shot <out.png> <base>:<frame> [<panel>:<frame> ...]") }
let layers = args.dropFirst().map(parse)
let base = layers[0]
// Pixels per point, from the base capture.
let rep = base.image.representations.first
let scale = CGFloat(rep?.pixelsWide ?? Int(base.frame.width)) / base.frame.width
let pixelSize = NSSize(width: base.frame.width * scale, height: base.frame.height * scale)

guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(pixelSize.width), pixelsHigh: Int(pixelSize.height),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else { fail("cannot allocate canvas") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
for layer in layers {
    // Top-left global points to bottom-left canvas pixels.
    let x = (layer.frame.minX - base.frame.minX) * scale
    let yFromTop = (layer.frame.minY - base.frame.minY) * scale
    let rect = NSRect(x: x, y: pixelSize.height - yFromTop - layer.frame.height * scale,
                      width: layer.frame.width * scale, height: layer.frame.height * scale)
    layer.image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
}
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else { fail("cannot encode png") }
do { try png.write(to: URL(fileURLWithPath: args[0])) } catch { fail("cannot write \(args[0])") }
print(args[0])
