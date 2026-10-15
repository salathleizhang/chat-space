import Foundation
import CoreText
import CoreGraphics

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let source = try String(contentsOf: root.appendingPathComponent("build.py"), encoding: .utf8)
let scalars = Set(source.unicodeScalars.filter { $0.value >= 32 && $0.value <= 0xffff })
var result: [String: Any] = [:]
for (key,name) in [("CN","PingFangSC-Regular"),("CNM","PingFangSC-Semibold")] {
    let font = CTFontCreateWithName(name as CFString, 100, nil)
    print(key,CTFontCopyPostScriptName(font))
    var glyphs: [String: Any] = [:]
    for scalar in scalars {
        var char = UniChar(scalar.value)
        var glyph: CGGlyph = 0
        CTFontGetGlyphsForCharacters(font, &char, &glyph, 1)
        var advance = CGSize.zero
        CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &advance, 1)
        var commands: [[Any]] = []
        if let path = CTFontCreatePathForGlyph(font, glyph, nil) {
            path.applyWithBlock { ptr in
                let el = ptr.pointee
                func coord(_ i:Int) -> [Double] {
                    [Double(el.points[i].x)/100,Double(el.points[i].y)/100]
                }
                switch el.type {
                case .moveToPoint: commands.append(["M"] + coord(0))
                case .addLineToPoint: commands.append(["L"] + coord(0))
                case .addQuadCurveToPoint: commands.append(["Q"] + coord(0) + coord(1))
                case .addCurveToPoint: commands.append(["C"] + coord(0) + coord(1) + coord(2))
                case .closeSubpath: commands.append(["Z"])
                @unknown default: break
                }
            }
        }
        glyphs[String(scalar)] = ["advance":Double(advance.width)/100,"commands":commands]
    }
    result[key] = glyphs
}
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
try data.write(to:root.appendingPathComponent("assets/font-outlines.json"))
