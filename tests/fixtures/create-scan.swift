import Foundation
import AppKit
import CoreGraphics

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let image = NSImage(size: NSSize(width: 1000, height: 600))
image.lockFocus()
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 1000, height: 600).fill()
let text = NSAttributedString(string: "Project target is 42", attributes: [.font: NSFont.systemFont(ofSize: 48), .foregroundColor: NSColor.black])
text.draw(at: NSPoint(x: 80, y: 380))
image.unlockFocus()
var rectangle = CGRect(x: 0, y: 0, width: 1000, height: 600)
guard let bitmap = image.cgImage(forProposedRect: &rectangle, context: nil, hints: nil),
      let context = CGContext(output as CFURL, mediaBox: &rectangle, nil) else { exit(1) }
context.beginPDFPage(nil)
context.draw(bitmap, in: rectangle)
context.endPDFPage()
context.closePDF()
