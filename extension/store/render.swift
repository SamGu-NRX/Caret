// Renders the Web Store images: the extension icons (extension/icons), three 1280x800 screenshots
// and the 440x280 small promo tile (extension/store).
//
// Pebble is not redrawn here. Caret ships it only as code, so its outline, sheen, eyes, catchlights,
// gradient and glow are copied number for number from apps/caret/Sources/CaretHost/Design/Figure.swift
// (Pebble, FigureView) and its colors from Design/Tokens.swift. If either file changes, change this.
//
// The screenshots compose real pictures only, scaled uniformly and cropped, never stretched:
// browser-window captures and the pop-up capture from the DF1 VM run, and a CI-recorded reference
// render of the page-task panel. Store images must be 24-bit PNG, so screenshots and the tile are
// written without alpha; icons keep it.
//
// Usage: swift extension/store/render.swift <repo root> <DF1 shots dir>
//   <DF1 shots dir> is ~/.caret-run/queue/ops/jobs/caret-df1-2d8af14-n1/inputs/vm-job/runs/20261009T044644Z-88912/out/shots

import AppKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("render: \(message)\n".utf8))
    exit(2)
}

guard CommandLine.arguments.count == 3 else { fail("usage: render.swift <repo root> <DF1 shots dir>") }
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let shots = URL(fileURLWithPath: CommandLine.arguments[2])
let references = root.appendingPathComponent("apps/caret/Tests/CaretHostTests/References")
let storeDir = root.appendingPathComponent("extension/store")
let iconDir = root.appendingPathComponent("extension/icons")
try FileManager.default.createDirectory(at: iconDir, withIntermediateDirectories: true)

func srgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

// MARK: Tokens.swift values

struct Skin {
    let core, mid, rim: UInt32
    let glow: UInt32
    let glowAlpha: CGFloat
}
let lightSkin = Skin(core: 0xFFC98A, mid: 0xEE8238, rim: 0xCC5A19, glow: 0xEC7E34, glowAlpha: 0.26)
let darkSkin = Skin(core: 0xFFD6A4, mid: 0xF49A5B, rim: 0xD16B28, glow: 0xF49A5B, glowAlpha: 0.40)
let eyeColor: UInt32 = 0x1D1D1F
let ink: UInt32 = 0x1C1B19, ink2: UInt32 = 0x625F5B
let darkInk: UInt32 = 0xF2EFEA, darkInk2: UInt32 = 0xABA7A0
let darkGlass: UInt32 = 0x262422
/// The backdrop the CI reference renders are drawn on (the stored bytes of
/// page-task-preview-light.png's corner), so a reference render sits on the canvas without a seam.
let canvas: UInt32 = 0xECECEE

// MARK: Pebble (Figure.swift), viewBox 12 by 11, y down

let viewBox = CGSize(width: 12, height: 11)

func pebbleOutline() -> CGPath {
    let p = CGMutablePath()
    p.move(to: CGPoint(x: 6, y: 0.6))
    p.addCurve(to: CGPoint(x: 11.7, y: 5.9), control1: CGPoint(x: 9.6, y: 0.6), control2: CGPoint(x: 11.7, y: 2.8))
    p.addCurve(to: CGPoint(x: 6, y: 10.4), control1: CGPoint(x: 11.7, y: 8.8), control2: CGPoint(x: 9.3, y: 10.4))
    p.addCurve(to: CGPoint(x: 0.3, y: 5.9), control1: CGPoint(x: 2.7, y: 10.4), control2: CGPoint(x: 0.3, y: 8.8))
    p.addCurve(to: CGPoint(x: 6, y: 0.6), control1: CGPoint(x: 0.3, y: 2.8), control2: CGPoint(x: 2.4, y: 0.6))
    p.closeSubpath()
    return p
}

/// Draws Pebble with its top-left at `origin` and `width` wide, in a y-down context. `eyeShift` is
/// the pose's eyeOffset in viewBox units: zero is Still, (1.1, 0) is Noticed facing right.
func drawPebble(_ c: CGContext, origin: CGPoint, width: CGFloat, skin: Skin, eyeShift: CGSize = .zero, glow: Bool = true) {
    let k = width / viewBox.width
    let size = CGSize(width: width, height: width * viewBox.height / viewBox.width)
    c.saveGState()
    c.translateBy(x: origin.x, y: origin.y)
    // FigureView: shadow(color: glow, radius: max(2, size / 4.5) / 2). SwiftUI's radius is the
    // blur's radius; CGContext's blur is about twice that for the same spread.
    if glow {
        c.setShadow(offset: .zero, blur: max(2, width / 4.5), color: srgb(skin.glow, skin.glowAlpha))
    }
    c.beginTransparencyLayer(auxiliaryInfo: nil)
    c.saveGState()
    c.scaleBy(x: k, y: k)
    c.addPath(pebbleOutline())
    c.restoreGState()
    c.saveGState()
    c.clip()
    // FigureSkin.fill: radial gradient core, mid, rim; center (0.38, 0.30); end radius max(w, h) * 0.78.
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [srgb(skin.core), srgb(skin.mid), srgb(skin.rim)] as CFArray, locations: [0, 0.5, 1])!
    let center = CGPoint(x: size.width * 0.38, y: size.height * 0.30)
    c.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: max(size.width, size.height) * 0.78, options: [.drawsAfterEndLocation])
    c.restoreGState()
    c.scaleBy(x: k, y: k)
    // Sheen: ellipse at (4.3, 2.7), 4.2 by 2.1, white 0.26.
    c.setFillColor(srgb(0xFFFFFF, 0.26))
    c.fillEllipse(in: CGRect(x: 4.3 - 2.1, y: 2.7 - 1.05, width: 4.2, height: 2.1))
    c.translateBy(x: eyeShift.width, y: eyeShift.height)
    c.setFillColor(srgb(eyeColor))
    for x in [3.9, 8.1] { c.fillEllipse(in: CGRect(x: x - 1.05, y: 5 - 1.05, width: 2.1, height: 2.1)) }
    c.setFillColor(srgb(0xFFFFFF, 0.85))
    for x in [3.55, 7.75] { c.fillEllipse(in: CGRect(x: x - 0.3, y: 4.65 - 0.3, width: 0.6, height: 0.6)) }
    c.endTransparencyLayer()
    c.restoreGState()
}

// MARK: Canvas and output

/// A y-down sRGB canvas. Opaque canvases drop alpha on write (24-bit PNG).
final class Canvas {
    let context: CGContext
    let width: Int, height: Int
    let opaque: Bool

    init(_ width: Int, _ height: Int, opaque: Bool) {
        self.width = width
        self.height = height
        self.opaque = opaque
        context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)
        context.interpolationQuality = .high
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
    }

    func fill(_ hex: UInt32) {
        context.setFillColor(srgb(hex))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    }

    func write(_ url: URL) {
        var image = context.makeImage()!
        if opaque {
            let flat = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                 space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            flat.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            image = flat.makeImage()!
        }
        let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { fail("cannot write \(url.path)") }
        print("wrote \(url.path) \(width)x\(height)")
    }
}

func load(_ url: URL) -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail("cannot read \(url.path)")
    }
    return image
}

/// Draws `image` (or its `crop`, in its own pixels) into `rect` of a y-down context.
func draw(_ c: CGContext, _ image: CGImage, crop: CGRect? = nil, in rect: CGRect) {
    let part = crop.map { image.cropping(to: $0)! } ?? image
    let scaleX = rect.width / CGFloat(part.width), scaleY = rect.height / CGFloat(part.height)
    guard abs(scaleX - scaleY) < 0.001 else { fail("would stretch: \(scaleX) vs \(scaleY)") }
    c.saveGState()
    c.translateBy(x: rect.minX, y: rect.maxY)
    c.scaleBy(x: 1, y: -1)
    c.draw(part, in: CGRect(x: 0, y: 0, width: rect.width, height: rect.height))
    c.restoreGState()
}

// MARK: Type: New York where Caret speaks a sentence, SF for everything else (Tokens.Font)

func newYork(_ size: CGFloat, _ weight: NSFont.Weight) -> NSFont {
    let base = NSFont.systemFont(ofSize: size, weight: weight)
    return NSFont(descriptor: base.fontDescriptor.withDesign(.serif)!, size: size)!
}

@discardableResult
func text(_ string: String, font: NSFont, color: UInt32, at point: CGPoint, width: CGFloat, lineHeight: CGFloat, tracking: CGFloat = 0) -> CGFloat {
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    paragraph.lineBreakStrategy = .standard
    let attributed = NSAttributedString(string: string, attributes: [
        .font: font, .foregroundColor: NSColor(cgColor: srgb(color))!, .paragraphStyle: paragraph, .kern: tracking,
    ])
    let bounds = attributed.boundingRect(with: CGSize(width: width, height: 1000), options: [.usesLineFragmentOrigin])
    attributed.draw(with: CGRect(x: point.x, y: point.y, width: width, height: ceil(bounds.height)), options: [.usesLineFragmentOrigin])
    return ceil(bounds.height)
}

// MARK: Icons

// Chrome's guidance: the 128 px icon is 96 px of art with 16 px of clear space; the small sizes
// use nearly the whole square. The glow only reads at 48 px and up; below that it blurs the edge.
for (size, art, glow) in [(16, 16.0, false), (32, 31.0, false), (48, 42.0, true), (128, 96.0, true)] {
    let canvas = Canvas(size, size, opaque: false)
    let height = art * viewBox.height / viewBox.width
    drawPebble(canvas.context, origin: CGPoint(x: (CGFloat(size) - art) / 2, y: (CGFloat(size) - height) / 2), width: art, skin: lightSkin, glow: glow)
    canvas.write(iconDir.appendingPathComponent("icon-\(size).png"))
}

// MARK: Screenshots

let noticed = CGSize(width: 1.1, height: 0)

/// Caret's line: the figure heads the sentence it speaks, then a plain line under it.
func caption(_ canvas: Canvas, title: String, detail: String, at origin: CGPoint, width: CGFloat) -> CGFloat {
    let figure: CGFloat = 40
    drawPebble(canvas.context, origin: CGPoint(x: origin.x, y: origin.y + 4), width: figure, skin: lightSkin, eyeShift: noticed)
    let x = origin.x + figure + 18
    let titleHeight = text(title, font: newYork(36, .medium), color: ink, at: CGPoint(x: x, y: origin.y - 3), width: width - figure - 18, lineHeight: 44, tracking: -0.3)
    let detailHeight = text(detail, font: NSFont.systemFont(ofSize: 20, weight: .regular), color: ink2, at: CGPoint(x: x, y: origin.y + titleHeight + 10), width: width - figure - 18, lineHeight: 28)
    return titleHeight + 10 + detailHeight
}

/// A browser capture as a card: rounded, the panels' 1 pt edge, a soft drop shadow.
func card(_ c: CGContext, _ image: CGImage, crop: CGRect, fit box: CGRect) {
    let scale = min(box.width / crop.width, box.height / crop.height)
    let size = CGSize(width: (crop.width * scale).rounded(), height: (crop.height * scale).rounded())
    let rect = CGRect(x: (box.midX - size.width / 2).rounded(), y: box.minY, width: size.width, height: crop.height * (size.width / crop.width))
    let shape = CGPath(roundedRect: rect, cornerWidth: 14, cornerHeight: 14, transform: nil)
    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: 10), blur: 40, color: srgb(0x000000, 0.14))
    c.addPath(shape)
    c.setFillColor(srgb(0xFFFFFF))
    c.fillPath()
    c.restoreGState()
    c.saveGState()
    c.addPath(shape)
    c.clip()
    draw(c, image, crop: crop, in: rect)
    c.restoreGState()
    c.addPath(shape)
    c.setStrokeColor(srgb(0x000000, 0.10))
    c.setLineWidth(1)
    c.strokePath()
}

let offer = load(shots.appendingPathComponent("fill-offer-87.png"))
let popup = load(shots.appendingPathComponent("fill-offer-caret-104.png"))
let after = load(shots.appendingPathComponent("fill-after-87.png"))
let preview = load(references.appendingPathComponent("page-task-preview-light.png"))
for (image, name, w, h) in [(offer, "fill-offer-87", 1832, 940), (after, "fill-after-87", 1832, 940), (popup, "fill-offer-caret-104", 518, 136), (preview, "page-task-preview-light", 776, 776)] {
    guard image.width == w, image.height == h else { fail("\(name) is \(image.width)x\(image.height), expected \(w)x\(h)") }
}

// The pop-up over the form, where it was. The VM's state names the field it was placed below at
// global (128.5, 217) points and the panel at (117.5, 255); the field's box in the 2x capture
// starts at (222, 368) px, so the window's content starts at (17.5, 33) points. The pop-up capture
// carries 24 pt of shadow on each side (48 px). It lands at (117.5 - 17.5) * 2 - 48 = 152 px and
// (255 - 33) * 2 - 48 = 396 px.
let composed = Canvas(offer.width, offer.height, opaque: false)
draw(composed.context, offer, in: CGRect(x: 0, y: 0, width: offer.width, height: offer.height))
draw(composed.context, popup, in: CGRect(x: 152, y: 396, width: popup.width, height: popup.height))
let offerWithPopup = composed.context.makeImage()!

// Crops keep the form and leave out the browser toolbar (a third-party extension's icon, a
// 127.0.0.1 address), the fixture's own note about being a test page, and the window's border.
let formCrop = CGRect(x: 190, y: 296, width: 1420, height: 636)
let afterCrop = CGRect(x: 190, y: 182, width: 1420, height: 732)
let cardBox = CGRect(x: 80, y: 216, width: 1120, height: 536)

do {
    let s = Canvas(1280, 800, opaque: true)
    s.fill(canvas)
    _ = caption(s, title: "Caret notices the form you're in", detail: "The extension reads the page's fields and hands them to the Caret app on your Mac.", at: CGPoint(x: 96, y: 72), width: 1088)
    card(s.context, offerWithPopup, crop: formCrop, fit: cardBox)
    s.write(storeDir.appendingPathComponent("screenshot-1-offer.png"))
}

do {
    let s = Canvas(1280, 800, opaque: true)
    s.fill(canvas)
    // The reference render is 2x and drawn on the canvas color, so it goes in at 1:1 pixels.
    draw(s.context, preview, in: CGRect(x: 1280 - 776 - 40, y: 12, width: 776, height: 776))
    let left: CGFloat = 96
    let width: CGFloat = 1280 - 776 - 40 - left
    drawPebble(s.context, origin: CGPoint(x: left, y: 252), width: 40, skin: lightSkin, eyeShift: noticed)
    let titleHeight = text("You see every value before it goes in", font: newYork(36, .medium), color: ink, at: CGPoint(x: left, y: 316), width: width, lineHeight: 44, tracking: -0.3)
    text("Each value says where it came from. Lists are picked from, and answers that are yours to write stay yours.", font: NSFont.systemFont(ofSize: 20, weight: .regular), color: ink2, at: CGPoint(x: left, y: 316 + titleHeight + 14), width: width - 8, lineHeight: 28)
    s.write(storeDir.appendingPathComponent("screenshot-2-preview.png"))
}

do {
    let s = Canvas(1280, 800, opaque: true)
    s.fill(canvas)
    _ = caption(s, title: "Press Tab and the form is filled", detail: "Caret writes the fields and stops there. Submitting is always your click.", at: CGPoint(x: 96, y: 72), width: 1088)
    card(s.context, after, crop: afterCrop, fit: cardBox)
    s.write(storeDir.appendingPathComponent("screenshot-3-filled.png"))
}

// MARK: Small promo tile

// The figure is light (Figure.swift, FigureSkin), so the tile is the dark glass with Pebble lit in
// its dark-theme colors, and the name beside it.
do {
    let t = Canvas(440, 280, opaque: true)
    t.fill(darkGlass)
    let c = t.context
    // The warm cast behind the figure (Tokens.glow, dark), widened for a tile seen at half size.
    let cast = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [srgb(0xF49A5B, 0.22), srgb(0xF49A5B, 0)] as CFArray, locations: [0, 1])!
    c.drawRadialGradient(cast, startCenter: CGPoint(x: 104, y: 142), startRadius: 0, endCenter: CGPoint(x: 104, y: 142), endRadius: 130, options: [])
    let figure: CGFloat = 112
    drawPebble(c, origin: CGPoint(x: 48, y: 140 - figure * viewBox.height / viewBox.width / 2), width: figure, skin: darkSkin, eyeShift: noticed)
    text("Caret", font: newYork(44, .medium), color: darkInk, at: CGPoint(x: 190, y: 96), width: 230, lineHeight: 50, tracking: -0.4)
    text("for Chrome", font: newYork(26, .regular), color: darkInk2, at: CGPoint(x: 191, y: 148), width: 230, lineHeight: 32)
    t.write(storeDir.appendingPathComponent("promo-small-440x280.png"))
}
