import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let S: CGFloat = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: Int(S), height: Int(S), bitsPerComponent: 8,
                    bytesPerRow: 0, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

func rgb(_ h: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((h >> 16) & 255)/255, green: CGFloat((h >> 8) & 255)/255,
            blue: CGFloat(h & 255)/255, alpha: a)
}

// rounded-square backdrop with a soft vertical gradient (app's surface tones)
let inset: CGFloat = S * 0.06
let rect = CGRect(x: inset, y: inset, width: S - inset*2, height: S - inset*2)
let path = CGPath(roundedRect: rect, cornerWidth: S*0.22, cornerHeight: S*0.22, transform: nil)
ctx.saveGState()
ctx.addPath(path); ctx.clip()
let grad = CGGradient(colorsSpace: cs, colors: [rgb(0x24262b), rgb(0x0e0e0e)] as CFArray,
                      locations: [0, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: S), end: CGPoint(x: 0, y: 0), options: [])
ctx.restoreGState()

// hub: centre node with satellites — the fleet motif from the in-app logo
let c = CGPoint(x: S/2, y: S/2)
let r: CGFloat = S * 0.235
let satR: CGFloat = S * 0.062
let coreR: CGFloat = S * 0.105
let angles: [CGFloat] = [90, 162, 234, 306, 18].map { $0 * .pi / 180 }
let sats = angles.map { CGPoint(x: c.x + cos($0)*r, y: c.y + sin($0)*r) }

ctx.setLineCap(.round)
ctx.setStrokeColor(rgb(0x569cd6, 0.85))
ctx.setLineWidth(S * 0.021)
for p in sats { ctx.move(to: c); ctx.addLine(to: p) }
ctx.strokePath()

ctx.setShadow(offset: .zero, blur: S*0.05, color: rgb(0x95ccff, 0.55))
ctx.setFillColor(rgb(0x95ccff))
for p in sats { ctx.fillEllipse(in: CGRect(x: p.x-satR, y: p.y-satR, width: satR*2, height: satR*2)) }
ctx.fillEllipse(in: CGRect(x: c.x-coreR, y: c.y-coreR, width: coreR*2, height: coreR*2))
ctx.setShadow(offset: .zero, blur: 0, color: nil)

// inner keyline so the icon reads on light backgrounds too
ctx.addPath(CGPath(roundedRect: rect.insetBy(dx: S*0.004, dy: S*0.004),
                   cornerWidth: S*0.216, cornerHeight: S*0.216, transform: nil))
ctx.setStrokeColor(rgb(0xffffff, 0.07)); ctx.setLineWidth(S*0.008); ctx.strokePath()

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)
print("wrote \(out.path)")
