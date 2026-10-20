import Foundation
import PDFKit
import Vision
import AppKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func recognize(_ page: PDFPage) throws -> String {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return "" }
    let scale = min(3.0, 2400.0 / max(bounds.width, bounds.height))
    let image = page.thumbnail(of: NSSize(width: bounds.width * scale, height: bounds.height * scale), for: .mediaBox)
    var rect = CGRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return "" }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

guard CommandLine.arguments.count >= 2 else { fail("Choose a PDF to read.") }
let maximum = CommandLine.arguments.count >= 3 ? (Int(CommandLine.arguments[2]) ?? 200000) : 200000
guard let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else { fail("This PDF is damaged or could not be read. Try a PDF or text export from its original app.") }
guard !document.isLocked else { fail("This PDF is password-protected. Choose an unlocked copy.") }
guard document.pageCount > 0 else { fail("This PDF has no pages.") }
guard document.pageCount <= 1000 else { fail("This PDF has more than 1,000 pages. Split it into smaller files.") }
var parts: [String] = []
var warnings = ["PDF text reading order may differ from the visual page layout. Images and charts are not described."]
var ocrPages: [Int] = []
var unreadablePages: [Int] = []
var characters = 0
var readable = false
for index in 0..<document.pageCount {
    autoreleasepool {
        guard let page = document.page(at: index) else { unreadablePages.append(index + 1); return }
        var text = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            do {
                text = try recognize(page).trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { ocrPages.append(index + 1) }
            } catch { /* Preserve explicit information about pages OCR could not read. */ }
        }
        if text.isEmpty {
            unreadablePages.append(index + 1)
            text = "[No readable text on this page after OCR.]"
        } else { readable = true }
        let part = "=== Page \(index + 1) ===\n\(text)"
        characters += part.utf16.count + 2
        if characters > maximum { fail("This PDF contains more than 200,000 characters. Split it into smaller files; no text was attached.") }
        parts.append(part)
    }
}
guard readable else { fail("No readable text was found in this PDF, including OCR. Use a clearer scan, a text/OCR PDF, or a text export.") }
if !ocrPages.isEmpty { warnings.append("Text was recognized with on-device OCR on pages \(ocrPages.map(String.init).joined(separator: ", ")). OCR can misread words and numbers; check important details against the original.") }
if !unreadablePages.isEmpty { warnings.append("No readable text was found on pages \(unreadablePages.map(String.init).joined(separator: ", ")). These pages may be blank or contain images; they were labeled in the extracted text.") }
let result: [String: Any] = ["text": parts.joined(separator: "\n\n"), "pages": document.pageCount, "warnings": warnings]
do {
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch { fail("The PDF reader could not return this document's text.") }
