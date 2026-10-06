import AppKit
import CaretHostCore
import SwiftUI

extension View {
    /// v41's glass under one light, upper left (DIRECTION 2.3): the page task panel and its crop. One material per
    /// surface; the crop's paper inside it is opaque.
    func lookPanel(radius: CGFloat = LookShape.radius) -> some View { modifier(LookPanel(radius: radius)) }
}

/// The stack, back to front: contact shadow and cast (outside the shape only), material, tint, lift, rim, highlight row
/// along the top edge, left edge line.
///
/// Off-screen renders (`drawsOwnSurface`) have no window behind them and so no material: the tint is drawn over the
/// render's own ground, which is what the contrast tests measure. On screen the material is macOS 26's glass, or
/// `NSVisualEffectView` before it; Reduce Transparency turns it off and the tint goes opaque (`PageTaskLook.material`).
struct LookPanel: ViewModifier {
    var radius: CGFloat
    @Environment(\.drawsOwnSurface) private var offscreen
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.lookReducesTransparency) private var forcedOpaque

    private var material: PageTaskLook.Material {
        let glass: Bool
        if #available(macOS 26.0, *) { glass = true } else { glass = false }
        return PageTaskLook.material(reduceTransparency: reduceTransparency || forcedOpaque, glassAvailable: glass)
    }

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        let opaque = material == .opaque
        content
            .background {
                ZStack(alignment: .top) {
                    if !offscreen { LookMaterial(material: material, shape: shape) }
                    shape.fill(Color(token: opaque ? CaretColor.panelOpaque : CaretColor.glassTint))
                    // The lift: the top 46 pt of the body brightens.
                    LinearGradient(colors: [Color(token: CaretColor.glassLift), .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: 46)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .clipShape(shape)
                }
            }
            .overlay { shape.strokeBorder(Color(token: CaretColor.glassRim), lineWidth: 0.5) }
            .overlay { shape.stroke(Color(token: CaretColor.glassOuter), lineWidth: 0.5).padding(-0.25) }
            .overlay(alignment: .top) {
                // The highlight row: the light catching the top edge, brightest at the left.
                LinearGradient(stops: [.init(color: Color(token: CaretColor.glassHi), location: 0), .init(color: Color(token: CaretColor.glassHi), location: 0.35),
                                       .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing)
                    .frame(height: 1)
                    .padding(.leading, 6)
                    .padding(.trailing, 10)
            }
            .overlay(alignment: .leading) {
                Color(token: CaretColor.glassHiSide).frame(width: 1).padding(.vertical, radius)
            }
            .background { LookShadow(radius: radius, offscreen: offscreen) }
    }
}

/// Renders that compare the opaque panel set this; on screen the system setting decides.
private struct LookReducesTransparencyKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    var lookReducesTransparency: Bool {
        get { self[LookReducesTransparencyKey.self] }
        set { self[LookReducesTransparencyKey.self] = newValue }
    }
}

/// The material itself. `glassEffect` is gated on macOS 26; the SDK this builds with has it.
private struct LookMaterial: View {
    var material: PageTaskLook.Material
    var shape: RoundedRectangle

    var body: some View {
        switch material {
        case .opaque:
            shape.fill(Color(token: CaretColor.panelOpaque))
        case .glass:
            if #available(macOS 26.0, *) {
                Color.clear.glassEffect(.regular, in: shape)
            } else {
                LookVisualEffect().clipShape(shape)
            }
        case .visualEffect:
            LookVisualEffect().clipShape(shape)
        }
    }
}

/// Glass before macOS 26: `.popover` light, `.hudWindow` dark, behind the window, always active (`FallbackMaterial`).
private struct LookVisualEffect: NSViewRepresentable {
    func makeNSView(context: Context) -> FallbackMaterial { FallbackMaterial() }
    func updateNSView(_ view: FallbackMaterial, context: Context) {}
}

/// v41's two shadows, one light from the upper left: contact (y 0.5, blur 1) and a cast that falls down and right (x 2,
/// y 14, blur 30, spread −10). Drawn outside the shape only, so the translucent glass never shows its own shadow.
struct LookShadowSpec: Equatable {
    struct Layer: Equatable {
        var color: UInt32
        var opacity: Double
        var x: CGFloat
        var y: CGFloat
        /// CSS blur; a layer's shadow radius is half.
        var blur: CGFloat
        /// CSS spread: the shadow's shape inset (negative) or outset.
        var spread: CGFloat
    }

    var contact: Layer
    var cast: Layer

    static func panel(dark: Bool) -> LookShadowSpec {
        dark
            ? LookShadowSpec(contact: Layer(color: 0x000000, opacity: 0.5, x: 0, y: 0.5, blur: 1, spread: 0),
                             cast: Layer(color: 0x000000, opacity: 0.62, x: 2, y: 16, blur: 34, spread: -10))
            : LookShadowSpec(contact: Layer(color: 0x000000, opacity: 0.10, x: 0, y: 0.5, blur: 1, spread: 0),
                             cast: Layer(color: 0x1E1408, opacity: 0.24, x: 2, y: 14, blur: 30, spread: -10))
    }
}

private struct LookShadow: View {
    var radius: CGFloat
    var offscreen: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if offscreen {
            // No window: SwiftUI draws the two layers, masked to outside the shape.
            let spec = LookShadowSpec.panel(dark: scheme == .dark)
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            ZStack {
                ForEach([spec.cast, spec.contact], id: \.blur) { layer in
                    RoundedRectangle(cornerRadius: max(0, radius + layer.spread), style: .continuous)
                        .fill(Color.black)
                        .padding(-layer.spread)
                        .shadow(color: Color(nsColor: Tokens.srgb(layer.color)).opacity(layer.opacity), radius: layer.blur / 2, x: layer.x, y: layer.y)
                }
            }
            .compositingGroup()
            .mask { OutsideMask(shape: shape, reach: 40) }
            .allowsHitTesting(false)
        } else {
            LookShadowLayers(radius: radius).allowsHitTesting(false)
        }
    }
}

/// Everything around a shape, out to `reach`, and nothing inside it.
private struct OutsideMask: View {
    var shape: RoundedRectangle
    var reach: CGFloat

    var body: some View {
        Rectangle()
            .padding(-reach)
            .overlay { shape.blendMode(.destinationOut) }
            .compositingGroup()
    }
}

/// On screen: two `CALayer` shadows with an explicit `shadowPath`, so the window server never renders an offscreen pass
/// to find the shape (v41 2.3 "Cost"), masked to outside the shape.
private struct LookShadowLayers: NSViewRepresentable {
    var radius: CGFloat

    func makeNSView(context: Context) -> LookShadowView { LookShadowView() }
    func updateNSView(_ view: LookShadowView, context: Context) { view.radius = radius }
}

final class LookShadowView: NSView {
    var radius: CGFloat = LookShape.radius { didSet { needsLayout = true } }
    /// How far past the shape the shadows may draw; the view draws outside its own bounds (the panel's window leaves
    /// `LookShape.shadowMargin` around the content for it).
    static let reach: CGFloat = LookShape.shadowMargin
    private let contact = CALayer()
    private let cast = CALayer()
    private let mask = CAShapeLayer()
    private let holder = CALayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = false
        holder.addSublayer(cast)
        holder.addSublayer(contact)
        mask.fillRule = .evenOdd
        holder.mask = mask
        layer?.addSublayer(holder)
    }

    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { false }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let spec = LookShadowSpec.panel(dark: dark)
        let r = Self.reach
        holder.frame = bounds.insetBy(dx: -r, dy: -r)
        let shape = CGRect(x: r, y: r, width: bounds.width, height: bounds.height)
        for (layer, s) in [(contact, spec.contact), (cast, spec.cast)] {
            layer.frame = holder.bounds
            let inset = shape.insetBy(dx: -s.spread, dy: -s.spread)
            layer.shadowPath = CGPath(roundedRect: inset, cornerWidth: max(0, radius + s.spread), cornerHeight: max(0, radius + s.spread), transform: nil)
            layer.shadowColor = Tokens.srgb(s.color).cgColor
            layer.shadowOpacity = Float(s.opacity)
            layer.shadowRadius = s.blur / 2
            // Layer space is bottom-left: a downward offset is negative.
            layer.shadowOffset = CGSize(width: s.x, height: -s.y)
        }
        let outside = CGMutablePath()
        outside.addRect(holder.bounds)
        outside.addPath(CGPath(roundedRect: shape, cornerWidth: radius, cornerHeight: radius, transform: nil))
        mask.path = outside
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsLayout = true
    }
}
