import AppKit

let output = CommandLine.arguments[1]
let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
let base = NSBezierPath(roundedRect: NSRect(x: 50, y: 50, width: 924, height: 924), xRadius: 218, yRadius: 218)
NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
base.fill()
func bubble(_ x: CGFloat, _ y: CGFloat, _ color: NSColor, _ flip: Bool) {
  color.setFill()
  NSBezierPath(roundedRect: NSRect(x: x, y: y, width: 440, height: 335), xRadius: 106, yRadius: 106).fill()
  let tail = NSBezierPath()
  tail.move(to: NSPoint(x: x + (flip ? 328 : 82), y: y + 52))
  tail.line(to: NSPoint(x: x + (flip ? 360 : 82), y: y - 58))
  tail.line(to: NSPoint(x: x + (flip ? 235 : 180), y: y + 10))
  tail.close()
  tail.fill()
}
bubble(170, 458, NSColor(calibratedWhite: 0.68, alpha: 1), false)
bubble(414, 252, NSColor(calibratedWhite: 0.95, alpha: 1), true)
NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
for x: CGFloat in [511, 615, 719] { NSBezierPath(ovalIn: NSRect(x: x, y: 393, width: 32, height: 32)).fill() }
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
